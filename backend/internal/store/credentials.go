package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Credential is a stored WebAuthn credential (passkey).
type Credential struct {
	ID                string // API id (uuid)
	UserID            string
	CredentialID      []byte
	PublicKey         []byte
	SignCount         uint32
	Transports        []string
	AAGUID            []byte
	Flags             byte
	AttestationType   string
	AttestationFormat string
	Name              string
	CreatedAt         time.Time
	LastUsedAt        *time.Time
	WrappedMKPRF      *string
}

const credColumns = `id, user_id, credential_id, public_key, sign_count, transports, aaguid, flags,
	attestation_type, attestation_format, name, created_at, last_used_at, wrapped_mk_prf`

func scanCredential(r rowScanner) (*Credential, error) {
	var (
		c          Credential
		transports string
		signCount  int64
		flags      int64
		created    int64
		lastUsed   sql.NullInt64
		prf        sql.NullString
	)
	err := r.Scan(&c.ID, &c.UserID, &c.CredentialID, &c.PublicKey, &signCount, &transports, &c.AAGUID, &flags,
		&c.AttestationType, &c.AttestationFormat, &c.Name, &created, &lastUsed, &prf)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.SignCount = uint32(signCount)
	c.Flags = byte(flags)
	if transports != "" {
		c.Transports = strings.Split(transports, ",")
	}
	c.CreatedAt = fromMS(created)
	c.LastUsedAt = fromNullMS(lastUsed)
	if prf.Valid {
		v := prf.String
		c.WrappedMKPRF = &v
	}
	return &c, nil
}

// MaxCredentials is how many passkeys one account may have. Each is a row with a public key
// and a wrapped master key that no storage limit counts, and the whole list is loaded for
// every WebAuthn ceremony, so it is bounded; nobody has twenty authenticators.
const MaxCredentials = 20

// ErrTooManyCredentials is returned by CreateCredential when the user has MaxCredentials.
var ErrTooManyCredentials = errors.New("too many passkeys")

// CreateCredential stores a new credential. Returns ErrConflict if the credential id exists,
// ErrTooManyCredentials if the user already has MaxCredentials.
func (s *Store) CreateCredential(ctx context.Context, c *Credential) error {
	return s.inTx(ctx, func(tx *Tx) error {
		if err := tx.lockUser(ctx, c.UserID); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM credentials WHERE user_id = ?`, c.UserID).Scan(&n); err != nil {
			return err
		}
		if n >= MaxCredentials {
			return ErrTooManyCredentials
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO credentials (id, user_id, credential_id, public_key, sign_count,
			transports, aaguid, flags, attestation_type, attestation_format, name, created_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			c.ID, c.UserID, c.CredentialID, c.PublicKey, int64(c.SignCount), strings.Join(c.Transports, ","),
			c.AAGUID, int64(c.Flags), c.AttestationType, c.AttestationFormat, c.Name, ms(c.CreatedAt))
		if tx.d.isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	})
}

// CredentialsByUser lists a user's credentials, oldest first.
func (s *Store) CredentialsByUser(ctx context.Context, userID string) ([]Credential, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+credColumns+` FROM credentials WHERE user_id = ? ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Credential
	for rows.Next() {
		c, err := scanCredential(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// CountCredentials returns how many passkeys a user has.
func (s *Store) CountCredentials(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM credentials WHERE user_id = ?`, userID).Scan(&n)
	return n, err
}

// CredentialByCredentialID loads a credential by its WebAuthn credential id.
func (s *Store) CredentialByCredentialID(ctx context.Context, credID []byte) (*Credential, error) {
	return scanCredential(s.db.QueryRowContext(ctx, `SELECT `+credColumns+` FROM credentials WHERE credential_id = ?`, credID))
}

// CredentialForUser loads a credential by API id, scoped to the user.
func (s *Store) CredentialForUser(ctx context.Context, userID, id string) (*Credential, error) {
	return scanCredential(s.db.QueryRowContext(ctx, `SELECT `+credColumns+` FROM credentials WHERE id = ? AND user_id = ?`, id, userID))
}

// RecordCredentialUse updates the sign counter, flags and last-used time after a successful assertion.
func (s *Store) RecordCredentialUse(ctx context.Context, id string, signCount uint32, flags byte, now time.Time) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE credentials SET sign_count = ?, flags = ?, last_used_at = ? WHERE id = ?`,
		int64(signCount), int64(flags), ms(now), id))
	return affectedOne(n, err)
}

// RenameCredential renames a user's credential.
func (s *Store) RenameCredential(ctx context.Context, userID, id, name string) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE credentials SET name = ? WHERE id = ? AND user_id = ?`, name, id, userID))
	return affectedOne(n, err)
}

// SetCredentialPRF stores the PRF-wrapped master key for a user's credential.
func (s *Store) SetCredentialPRF(ctx context.Context, userID, id, wrapped string) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE credentials SET wrapped_mk_prf = ? WHERE id = ? AND user_id = ?`, wrapped, id, userID))
	return affectedOne(n, err)
}

// DeleteCredential deletes a user's credential.
func (s *Store) DeleteCredential(ctx context.Context, userID, id string) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `DELETE FROM credentials WHERE id = ? AND user_id = ?`, id, userID))
	return affectedOne(n, err)
}
