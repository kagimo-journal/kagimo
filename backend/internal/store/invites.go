package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"strings"
	"time"
)

// Invite is an admin-minted sign-up code (migration 0006). The code itself is never stored.
type Invite struct {
	ID        string
	Note      string
	CreatedBy string // "" if that admin was deleted
	CreatedAt time.Time
	UsedAt    *time.Time
	UsedBy    string // username of the account that redeemed it; "" if unused or since deleted
}

// inviteAlphabet is Crockford's base32: no I, L, O or U to misread.
const inviteAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewInviteCode returns 16 random characters (80 bits) as XXXX-XXXX-XXXX-XXXX.
func NewInviteCode() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	var sb strings.Builder
	for i, v := range b {
		if i > 0 && i%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(inviteAlphabet[v&31]) // 256 is a multiple of 32: uniform
	}
	return sb.String(), nil
}

// NormalizeInviteCode folds case and drops everything but letters and digits, so "abcd-efgh"
// and "ABCDEFGH" are the same code.
func NormalizeInviteCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// InviteCodeHash is what the database keeps for a code.
func InviteCodeHash(code string) []byte {
	h := sha256.Sum256([]byte(NormalizeInviteCode(code)))
	return h[:]
}

// CreateInvite stores a new invite for the given code.
func (s *Store) CreateInvite(ctx context.Context, inv *Invite, code string) error {
	var by sql.NullString
	if inv.CreatedBy != "" {
		by = sql.NullString{String: inv.CreatedBy, Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO invites (id, code_hash, note, created_by, created_at) VALUES (?,?,?,?,?)`,
		inv.ID, InviteCodeHash(code), inv.Note, by, ms(inv.CreatedAt))
	if s.d.isUniqueViolation(err) {
		return ErrConflict
	}
	return err
}

// ListInvites returns every invite, newest first.
func (s *Store) ListInvites(ctx context.Context) ([]Invite, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT i.id, i.note, COALESCE(i.created_by, ''), i.created_at, i.used_at,
		COALESCE(u.username, '') FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC, i.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		var (
			inv     Invite
			created int64
			used    sql.NullInt64
		)
		if err := rows.Scan(&inv.ID, &inv.Note, &inv.CreatedBy, &created, &used, &inv.UsedBy); err != nil {
			return nil, err
		}
		inv.CreatedAt = fromMS(created)
		inv.UsedAt = fromNullMS(used)
		out = append(out, inv)
	}
	return out, rows.Err()
}

// DeleteInvite withdraws an unused invite. A used one is kept as a record (ErrConflict).
func (s *Store) DeleteInvite(ctx context.Context, id string) error {
	return s.inTx(ctx, func(tx *Tx) error {
		var used sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT used_at FROM invites WHERE id = ?`+tx.d.forUpdate(), id).Scan(&used); err == sql.ErrNoRows {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if used.Valid {
			return ErrConflict
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM invites WHERE id = ?`, id)
		return err
	})
}

// redeemInvite marks the invite used by u and comps u. Runs inside CreateUserWithInvite's
// transaction, after the user row exists.
func redeemInvite(ctx context.Context, tx *Tx, u *User, codeHash []byte) error {
	n, err := rowsAffected(tx.ExecContext(ctx, `UPDATE invites SET used_by = ?, used_at = ?
		WHERE code_hash = ? AND used_at IS NULL`, u.ID, ms(u.CreatedAt), codeHash))
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrInvalidInvite
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET comped = 1 WHERE id = ?`, u.ID); err != nil {
		return err
	}
	u.Comped = true
	return nil
}
