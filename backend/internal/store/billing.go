package store

import (
	"context"
	"database/sql"
	"errors"
)

// SetStripeCustomer records the user's Stripe customer id unless one is already set, and
// returns the id now stored (the existing one if another request won the race).
func (s *Store) SetStripeCustomer(ctx context.Context, userID, customerID string) (string, error) {
	var stored string
	err := s.inTx(ctx, func(tx *Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET stripe_customer_id = ?
			WHERE id = ? AND stripe_customer_id IS NULL`, customerID, userID); err != nil {
			return err
		}
		var v sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT stripe_customer_id FROM users WHERE id = ?`, userID).Scan(&v)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		stored = v.String
		return err
	})
	return stored, err
}

// UserByStripeCustomer loads the user that owns a Stripe customer id.
func (s *Store) UserByStripeCustomer(ctx context.Context, customerID string) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE stripe_customer_id = ?`, customerID))
}

// SetSubscription stores the user's subscription state as last read from Stripe.
func (s *Store) SetSubscription(ctx context.Context, userID string, sub SubscriptionState) error {
	var end int64
	if !sub.PeriodEnd.IsZero() {
		end = ms(sub.PeriodEnd)
	}
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE users SET sub_status = ?, sub_period_end = ?,
		sub_cancel_at_period_end = ? WHERE id = ?`, sub.Status, end, boolInt(sub.CancelAtPeriodEnd), userID))
	return affectedOne(n, err)
}

// SetComped grants or removes unlimited free use.
func (s *Store) SetComped(ctx context.Context, userID string, comped bool) error {
	n, err := rowsAffected(s.db.ExecContext(ctx, `UPDATE users SET comped = ? WHERE id = ?`, boolInt(comped), userID))
	return affectedOne(n, err)
}
