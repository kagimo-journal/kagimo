-- Invite codes (SPEC §5.6). An admin mints as many as they like; signing up with one gives the new
-- account free access (comped). Each code works once. Only a SHA-256 of the code is stored, so the
-- code itself is shown to the admin once, when it is made.
CREATE TABLE invites (
    id         TEXT PRIMARY KEY,                                  -- uuid v4, used in the API
    code_hash  BLOB NOT NULL UNIQUE,                              -- sha256(normalized code)
    note       TEXT NOT NULL DEFAULT '',                          -- who it's for, as the admin wrote it
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
    used_at    INTEGER                                            -- set once; a deleted user's code stays used
);
