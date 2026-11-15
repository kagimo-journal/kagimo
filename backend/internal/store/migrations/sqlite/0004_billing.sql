-- Billing (SPEC §5.6). Free accounts may store a limited amount on the server; a Stripe
-- subscription or an admin "comp" lifts the limit. Only Stripe ids and dates are stored.
ALTER TABLE users ADD COLUMN comped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN sub_status TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN sub_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sub_cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX users_stripe_customer ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Accounts that existed before billing are grandfathered.
UPDATE users SET comped = 1;
