package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Session states.
const (
	SessionMFAPending = "mfa_pending"
	SessionFull       = "full"
)

// Session is a row of the sessions table. The raw token is never stored.
type Session struct {
	IDHash     []byte
	UserID     string
	State      string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LastSeenAt time.Time
	// AuthAt is when the session last proved a credential (zero for mfa_pending).
	AuthAt time.Time
	// MFAFailures counts the wrong second-step answers an mfa_pending session has given.
	MFAFailures int
}

// CreateSession inserts a session.
func (s *Store) CreateSession(ctx context.Context, sess *Session) error {
	authAt := int64(0)
	if !sess.AuthAt.IsZero() {
		authAt = ms(sess.AuthAt)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (id_hash, user_id, state, created_at, expires_at, last_seen_at, auth_at)
		VALUES (?,?,?,?,?,?,?)`, sess.IDHash, sess.UserID, sess.State, ms(sess.CreatedAt), ms(sess.ExpiresAt), ms(sess.LastSeenAt), authAt)
	return err
}

// SessionByHash loads a non-expired session.
func (s *Store) SessionByHash(ctx context.Context, idHash []byte, now time.Time) (*Session, error) {
	var (
		sess                              Session
		created, expires, lastSee, authAt int64
	)
	err := s.db.QueryRowContext(ctx, `SELECT id_hash, user_id, state, created_at, expires_at, last_seen_at, auth_at, mfa_failures
		FROM sessions WHERE id_hash = ? AND expires_at > ?`, idHash, ms(now)).
		Scan(&sess.IDHash, &sess.UserID, &sess.State, &created, &expires, &lastSee, &authAt, &sess.MFAFailures)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	sess.CreatedAt, sess.ExpiresAt, sess.LastSeenAt = fromMS(created), fromMS(expires), fromMS(lastSee)
	if authAt > 0 {
		sess.AuthAt = fromMS(authAt)
	}
	return &sess, nil
}

// MarkSessionAuthenticated records that the session just proved a credential.
func (s *Store) MarkSessionAuthenticated(ctx context.Context, idHash []byte, now time.Time) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE sessions SET auth_at = ? WHERE id_hash = ?`, ms(now), idHash))
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// FailMFASession counts one more wrong second-step answer against the session and returns
// the total. ErrNotFound if the session is gone.
func (s *Store) FailMFASession(ctx context.Context, idHash []byte) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE id_hash = ? RETURNING mfa_failures`, idHash).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return n, err
}

// TouchSession updates last_seen_at.
func (s *Store) TouchSession(ctx context.Context, idHash []byte, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?`, ms(now), idHash)
	return err
}

// DeleteSession removes a single session.
func (s *Store) DeleteSession(ctx context.Context, idHash []byte) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id_hash = ?`, idHash)
	return err
}

// DeleteUserSessions removes all sessions of a user except the one with keepHash (may be nil).
func (s *Store) DeleteUserSessions(ctx context.Context, userID string, keepHash []byte) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND id_hash != ?`, userID, nonNil(keepHash))
	return err
}

// DeleteExpired removes expired sessions and recovery tokens.
func (s *Store) DeleteExpired(ctx context.Context, now time.Time) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, ms(now)); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM recovery_tokens WHERE expires_at <= ? OR used_at IS NOT NULL`, ms(now))
	return err
}

func nonNil(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}

// CreateRecoveryToken stores a hashed single-use recovery token.
func (s *Store) CreateRecoveryToken(ctx context.Context, tokenHash []byte, userID string, now, expires time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO recovery_tokens (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
		tokenHash, userID, ms(now), ms(expires))
	return err
}

// RecoveryTokenUser returns the user id of a valid (unused, unexpired) token without
// spending it. ErrNotFound otherwise.
func (s *Store) RecoveryTokenUser(ctx context.Context, tokenHash []byte, now time.Time) (string, error) {
	var userID string
	err := s.db.QueryRowContext(ctx, `SELECT user_id FROM recovery_tokens
		WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`, tokenHash, ms(now)).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return userID, err
}

// ConsumeRecoveryToken marks a valid token used and returns its user id.
func (s *Store) ConsumeRecoveryToken(ctx context.Context, tokenHash []byte, now time.Time) (string, error) {
	var userID string
	err := s.inTx(ctx, func(tx *Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT user_id FROM recovery_tokens
			WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`+tx.d.forUpdate(), tokenHash, ms(now)).Scan(&userID)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE recovery_tokens SET used_at = ? WHERE token_hash = ?`, ms(now), tokenHash)
		return err
	})
	return userID, err
}
