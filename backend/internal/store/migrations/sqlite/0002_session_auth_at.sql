-- When the session last proved a credential (sign-in, sign-up, recovery, or re-authentication).
-- Security-sensitive account changes require this to be recent (SPEC §5.1 "Re-authentication").
ALTER TABLE sessions ADD COLUMN auth_at INTEGER NOT NULL DEFAULT 0;
