-- Brute-force counters that must survive a restart (the machine stops when idle, and a
-- counter kept in memory would start again from zero every time it does).
--
-- Escalating TOTP lockout (SPEC §5.1 "Rate limits"): wrong codes are counted per account in a
-- window that starts at totp_fail_window_start; crossing a step sets totp_locked_until.
ALTER TABLE users ADD COLUMN totp_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_fail_window_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_locked_until INTEGER NOT NULL DEFAULT 0;
-- Wrong second-step answers (TOTP codes, passkey assertions) given to an mfa_pending session.
ALTER TABLE sessions ADD COLUMN mfa_failures INTEGER NOT NULL DEFAULT 0;
