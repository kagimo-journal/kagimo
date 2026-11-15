package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// User statuses.
const (
	StatusActive   = "active"
	StatusDisabled = "disabled"
)

// KDF holds the client-side passphrase KDF parameters.
type KDF struct {
	Salt []byte
	M    int
	T    int
	P    int
}

// User is a row of the users table.
type User struct {
	ID                string
	Username          string
	Note              string
	Status            string
	IsAdmin           bool
	WebAuthnHandle    []byte
	KDF               KDF
	AuthHash          string
	RecoveryHash      string
	WrappedMKPass     string
	WrappedMKRecovery string
	TOTPSecretEnc     []byte
	TOTPPendingEnc    []byte
	LastTOTPStep      int64
	CreatedAt         time.Time
	ApprovedAt        *time.Time
	LastActiveAt      *time.Time

	// TOTPFailures is the escalating TOTP lockout's state (migration 0007).
	TOTPFailures TOTPFailures

	// Billing (migration 0004).
	Comped           bool   // never limited (grandfathered or granted by an admin)
	StripeCustomerID string // "" until the first checkout
	Sub              SubscriptionState
}

// SubscriptionState mirrors the user's Stripe subscription, as last synced.
type SubscriptionState struct {
	Status            string    // Stripe status ("active", "past_due", "canceled", …) or ""
	PeriodEnd         time.Time // zero if none
	CancelAtPeriodEnd bool
}

// TOTPFailures counts an account's wrong TOTP codes for the escalating lockout (SPEC §5.1
// "Rate limits"). It lives in the users row so that a restart neither forgets the count nor
// lifts a lock. The zero value is a clean slate.
type TOTPFailures struct {
	Count       int
	WindowStart time.Time // zero if Count is 0
	LockedUntil time.Time // zero if never locked
}

// TOTPEnabled reports whether the user has a confirmed TOTP secret.
func (u *User) TOTPEnabled() bool { return len(u.TOTPSecretEnc) > 0 }

const userColumns = `id, username, note, status, is_admin, webauthn_handle, kdf_salt, kdf_m, kdf_t, kdf_p,
	auth_hash, recovery_hash, wrapped_mk_pass, wrapped_mk_recovery, totp_secret_enc, totp_pending_enc,
	last_totp_step, created_at, approved_at, last_active_at,
	comped, stripe_customer_id, sub_status, sub_period_end, sub_cancel_at_period_end,
	totp_fail_count, totp_fail_window_start, totp_locked_until`

type rowScanner interface{ Scan(dest ...any) error }

func scanUser(r rowScanner) (*User, error) {
	var (
		u                  User
		isAdmin            int
		created            int64
		approved, lastSeen sql.NullInt64
		comped, cancelEnd  int
		periodEnd          int64
		customer           sql.NullString
		failStart, locked  int64
	)
	err := r.Scan(&u.ID, &u.Username, &u.Note, &u.Status, &isAdmin, &u.WebAuthnHandle,
		&u.KDF.Salt, &u.KDF.M, &u.KDF.T, &u.KDF.P, &u.AuthHash, &u.RecoveryHash,
		&u.WrappedMKPass, &u.WrappedMKRecovery, &u.TOTPSecretEnc, &u.TOTPPendingEnc,
		&u.LastTOTPStep, &created, &approved, &lastSeen,
		&comped, &customer, &u.Sub.Status, &periodEnd, &cancelEnd,
		&u.TOTPFailures.Count, &failStart, &locked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.IsAdmin = isAdmin != 0
	u.CreatedAt = fromMS(created)
	u.ApprovedAt = fromNullMS(approved)
	u.LastActiveAt = fromNullMS(lastSeen)
	u.Comped = comped != 0
	u.StripeCustomerID = customer.String
	if periodEnd > 0 {
		u.Sub.PeriodEnd = fromMS(periodEnd)
	}
	u.Sub.CancelAtPeriodEnd = cancelEnd != 0
	if failStart > 0 {
		u.TOTPFailures.WindowStart = fromMS(failStart)
	}
	if locked > 0 {
		u.TOTPFailures.LockedUntil = fromMS(locked)
	}
	return &u, nil
}

// CreateUser inserts a new user. If the database has no users yet, the new user
// becomes an admin (bootstrap). Every new user is active straight away. The returned
// user reflects the final state.
// Returns ErrConflict if the username is taken.
func (s *Store) CreateUser(ctx context.Context, u *User) error {
	return s.createUser(ctx, u, nil)
}

// CreateUserWithInvite creates the user and redeems the invite whose code hashes to codeHash, in
// one transaction: the account is comped, and an unknown or already used code (ErrInvalidInvite)
// creates nothing.
func (s *Store) CreateUserWithInvite(ctx context.Context, u *User, codeHash []byte) error {
	return s.createUser(ctx, u, codeHash)
}

func (s *Store) createUser(ctx context.Context, u *User, inviteHash []byte) error {
	return s.inTx(ctx, func(tx *Tx) error {
		if err := tx.lockSignups(ctx); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
			return err
		}
		u.IsAdmin = n == 0
		u.Status = StatusActive
		t := u.CreatedAt
		u.ApprovedAt = &t
		approved := sql.NullInt64{Int64: ms(t), Valid: true}
		_, err := tx.ExecContext(ctx, `INSERT INTO users (id, username, note, status, is_admin, webauthn_handle,
			kdf_salt, kdf_m, kdf_t, kdf_p, auth_hash, recovery_hash, wrapped_mk_pass, wrapped_mk_recovery,
			created_at, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			u.ID, u.Username, u.Note, u.Status, boolInt(u.IsAdmin), u.WebAuthnHandle,
			u.KDF.Salt, u.KDF.M, u.KDF.T, u.KDF.P, u.AuthHash, u.RecoveryHash,
			u.WrappedMKPass, u.WrappedMKRecovery, ms(u.CreatedAt), approved)
		if tx.d.isUniqueViolation(err) {
			return ErrConflict
		}
		if err != nil || inviteHash == nil {
			return err
		}
		return redeemInvite(ctx, tx, u, inviteHash)
	})
}

// CountUsers returns the number of users.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// UserByID loads a user by id.
func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

// UserByUsername loads a user by username (case-insensitive).
func (s *Store) UserByUsername(ctx context.Context, username string) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE `+s.d.usernameEq(), username))
}

// UserByWebAuthnHandle loads a user by WebAuthn user handle.
func (s *Store) UserByWebAuthnHandle(ctx context.Context, handle []byte) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE webauthn_handle = ?`, handle))
}

// TouchUser records user activity.
func (s *Store) TouchUser(ctx context.Context, id string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET last_active_at = ? WHERE id = ?`, ms(now), id)
	return err
}

// UpdatePassphrase replaces the KDF params, auth hash and passphrase-wrapped MK,
// and deletes the user's outstanding recovery tokens (a token issued before the
// change must not be able to overwrite the new passphrase).
func (s *Store) UpdatePassphrase(ctx context.Context, id string, kdf KDF, authHash, wrapped string) error {
	return s.inTx(ctx, func(tx *Tx) error {
		n, err := rowsAffected(tx.ExecContext(ctx, `UPDATE users SET kdf_salt = ?, kdf_m = ?, kdf_t = ?, kdf_p = ?,
			auth_hash = ?, wrapped_mk_pass = ? WHERE id = ?`, kdf.Salt, kdf.M, kdf.T, kdf.P, authHash, wrapped, id))
		if err := affectedOne(n, err); err != nil {
			return err
		}
		return deleteRecoveryTokens(ctx, tx, id)
	})
}

// UpdateRecovery replaces the recovery auth hash and recovery-wrapped MK, and
// deletes the user's outstanding recovery tokens (issued under the old key).
func (s *Store) UpdateRecovery(ctx context.Context, id, recoveryHash, wrapped string) error {
	return s.inTx(ctx, func(tx *Tx) error {
		n, err := rowsAffected(tx.ExecContext(ctx, `UPDATE users SET recovery_hash = ?, wrapped_mk_recovery = ? WHERE id = ?`,
			recoveryHash, wrapped, id))
		if err := affectedOne(n, err); err != nil {
			return err
		}
		return deleteRecoveryTokens(ctx, tx, id)
	})
}

func deleteRecoveryTokens(ctx context.Context, tx *Tx, userID string) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM recovery_tokens WHERE user_id = ?`, userID)
	return err
}

// CountRecoveryTokens returns the number of recovery token rows (used or not) of a user.
func (s *Store) CountRecoveryTokens(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_tokens WHERE user_id = ?`, userID).Scan(&n)
	return n, err
}

// SetPendingTOTP stores an encrypted, not yet confirmed TOTP secret.
func (s *Store) SetPendingTOTP(ctx context.Context, id string, enc []byte) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE users SET totp_pending_enc = ? WHERE id = ?`, enc, id))
	return affectedOne(n, err)
}

// EnableTOTP promotes the pending secret to the active one. The confirming
// code's step must already have been recorded with ConsumeTOTPStep.
func (s *Store) EnableTOTP(ctx context.Context, id string) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE users SET totp_secret_enc = totp_pending_enc,
		totp_pending_enc = NULL WHERE id = ? AND totp_pending_enc IS NOT NULL`, id))
	if err == nil && n == 0 {
		return ErrConflict
	}
	return err
}

// DisableTOTP removes the TOTP secret.
func (s *Store) DisableTOTP(ctx context.Context, id string) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL WHERE id = ?`, id))
	return affectedOne(n, err)
}

// ConsumeTOTPStep atomically records step as used; it returns false if the step
// (or a later one) has already been used, which is how replays are rejected.
func (s *Store) ConsumeTOTPStep(ctx context.Context, id string, step int64) (bool, error) {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE users SET last_totp_step = ? WHERE id = ? AND last_totp_step < ?`,
		step, id, step))
	return n == 1, err
}

// UpdateTOTPFailures replaces the user's TOTP failure state with next(current), atomically,
// and returns the new state. Concurrent wrong codes are each counted.
func (s *Store) UpdateTOTPFailures(ctx context.Context, id string, next func(TOTPFailures) TOTPFailures) (TOTPFailures, error) {
	var st TOTPFailures
	err := s.inTx(ctx, func(tx *Tx) error {
		var start, locked int64
		err := tx.QueryRowContext(ctx, `SELECT totp_fail_count, totp_fail_window_start, totp_locked_until FROM users WHERE id = ?`+tx.d.forUpdate(), id).
			Scan(&st.Count, &start, &locked)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if start > 0 {
			st.WindowStart = fromMS(start)
		}
		if locked > 0 {
			st.LockedUntil = fromMS(locked)
		}
		st = next(st)
		_, err = tx.ExecContext(ctx, `UPDATE users SET totp_fail_count = ?, totp_fail_window_start = ?, totp_locked_until = ? WHERE id = ?`,
			st.Count, msOrZero(st.WindowStart), msOrZero(st.LockedUntil), id)
		return err
	})
	return st, err
}

// ResetTOTPFailures clears the user's TOTP failure count and any lock (after a correct code).
func (s *Store) ResetTOTPFailures(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET totp_fail_count = 0, totp_fail_window_start = 0, totp_locked_until = 0
		WHERE id = ? AND (totp_fail_count != 0 OR totp_locked_until != 0)`, id)
	return err
}

// SetStatus changes a user's status. Activating records approved_at if unset. Disabling
// also deletes all of the user's sessions and recovery tokens.
func (s *Store) SetStatus(ctx context.Context, id, status string, now time.Time) error {
	return s.inTx(ctx, func(tx *Tx) error {
		var n int64
		var err error
		if status == StatusActive {
			n, err = rowsAffected(tx.ExecContext(ctx, `UPDATE users SET status = ?, approved_at = COALESCE(approved_at, ?) WHERE id = ?`,
				status, ms(now), id))
		} else {
			n, err = rowsAffected(tx.ExecContext(ctx, `UPDATE users SET status = ? WHERE id = ?`, status, id))
		}
		if err := affectedOne(n, err); err != nil {
			return err
		}
		if status == StatusDisabled {
			if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_tokens WHERE user_id = ?`, id); err != nil {
				return err
			}
		}
		return nil
	})
}

// SetAdmin sets or clears the admin flag.
func (s *Store) SetAdmin(ctx context.Context, id string, admin bool) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE users SET is_admin = ? WHERE id = ?`, boolInt(admin), id))
	return affectedOne(n, err)
}

// DeleteUser deletes a user and (via cascades) all their data.
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id))
	return affectedOne(n, err)
}

// UserSummary is a user row enriched with aggregate data for the admin view.
type UserSummary struct {
	User
	StorageBytes int64
	PasskeyCount int
}

// HasSecondFactor reports whether the user has TOTP or at least one passkey.
func (u *UserSummary) HasSecondFactor() bool { return u.TOTPEnabled() || u.PasskeyCount > 0 }

// textStorageExpr is what an account's storage limit measures: entries and settings. Photos
// can no longer be uploaded, so the ones already stored don't count against it.
const textStorageExpr = `(
	COALESCE((SELECT SUM(LENGTH(header_ct) + LENGTH(body_ct) + LENGTH(header_nonce) + LENGTH(body_nonce)) FROM entries e WHERE e.user_id = u.id), 0) +
	COALESCE((SELECT LENGTH(ct) + LENGTH(nonce) FROM settings st WHERE st.user_id = u.id), 0))`

// storageExpr is everything an account stores, photos included (the admin view).
const storageExpr = `(
	COALESCE((SELECT SUM(size) FROM blobs b WHERE b.user_id = u.id), 0) + ` + textStorageExpr + `)`

// ListUsers returns all users with aggregates, oldest first.
func (s *Store) ListUsers(ctx context.Context) ([]UserSummary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+prefixed("u.", userColumns)+`, `+storageExpr+`,
		(SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id)
		FROM users u ORDER BY u.created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UserSummary
	for rows.Next() {
		var (
			sum UserSummary
			sb  sql.NullInt64
		)
		u, err := scanUser(scanFunc(func(dest ...any) error {
			return rows.Scan(append(dest, &sb, &sum.PasskeyCount)...)
		}))
		if err != nil {
			return nil, err
		}
		sum.User = *u
		sum.StorageBytes = sb.Int64
		out = append(out, sum)
	}
	return out, rows.Err()
}

// UserSummaryByID returns one user with aggregates.
func (s *Store) UserSummaryByID(ctx context.Context, id string) (*UserSummary, error) {
	var (
		sum UserSummary
		sb  sql.NullInt64
	)
	row := s.db.QueryRowContext(ctx, `SELECT `+prefixed("u.", userColumns)+`, `+storageExpr+`,
		(SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id)
		FROM users u WHERE u.id = ?`, id)
	u, err := scanUser(scanFunc(func(dest ...any) error {
		return row.Scan(append(dest, &sb, &sum.PasskeyCount)...)
	}))
	if err != nil {
		return nil, err
	}
	sum.User = *u
	sum.StorageBytes = sb.Int64
	return &sum, nil
}

// Stats are instance-wide aggregates.
type Stats struct {
	Members      int
	StorageBytes int64
}

// Stats returns instance-wide aggregates.
func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var st Stats
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM users WHERE status = 'active'),
		COALESCE((SELECT SUM(size) FROM blobs), 0) +
		COALESCE((SELECT SUM(LENGTH(header_ct) + LENGTH(body_ct) + LENGTH(header_nonce) + LENGTH(body_nonce)) FROM entries), 0) +
		COALESCE((SELECT SUM(LENGTH(ct) + LENGTH(nonce)) FROM settings), 0)`).Scan(&st.Members, &st.StorageBytes)
	return st, err
}

type scanFunc func(dest ...any) error

func (f scanFunc) Scan(dest ...any) error { return f(dest...) }

func prefixed(prefix, cols string) string {
	out := make([]byte, 0, len(cols)*2)
	start := true
	for i := 0; i < len(cols); i++ {
		c := cols[i]
		if start && c != ' ' && c != '\n' && c != '\t' {
			out = append(out, prefix...)
			start = false
		}
		if c == ',' {
			start = true
		}
		out = append(out, c)
	}
	return string(out)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func affectedOne(n int64, err error) error {
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
