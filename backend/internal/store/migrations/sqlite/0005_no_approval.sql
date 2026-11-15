-- Sign-up no longer waits for an administrator: anyone still pending becomes active.
UPDATE users SET status = 'active', approved_at = COALESCE(approved_at, created_at) WHERE status = 'pending';
