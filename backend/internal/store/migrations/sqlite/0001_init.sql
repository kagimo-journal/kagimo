-- Initial schema. All timestamps are unix milliseconds (UTC).

CREATE TABLE users (
    id                  TEXT PRIMARY KEY,                 -- uuid v4
    username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    note                TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
    is_admin            INTEGER NOT NULL DEFAULT 0,
    webauthn_handle     BLOB NOT NULL UNIQUE,             -- random 32-byte WebAuthn user handle
    kdf_salt            BLOB NOT NULL,
    kdf_m               INTEGER NOT NULL,
    kdf_t               INTEGER NOT NULL,
    kdf_p               INTEGER NOT NULL,
    auth_hash           TEXT NOT NULL,                    -- argon2id(authKey) PHC string
    recovery_hash       TEXT NOT NULL,                    -- argon2id(recoveryAuthKey) PHC string
    wrapped_mk_pass     TEXT NOT NULL,                    -- opaque client JSON
    wrapped_mk_recovery TEXT NOT NULL,                    -- opaque client JSON
    totp_secret_enc     BLOB,                             -- AES-GCM(secret.key) of enabled secret
    totp_pending_enc    BLOB,                             -- AES-GCM(secret.key) of secret awaiting confirmation
    last_totp_step      INTEGER NOT NULL DEFAULT 0,       -- replay protection
    created_at          INTEGER NOT NULL,
    approved_at         INTEGER,
    last_active_at      INTEGER
);

CREATE TABLE credentials (
    id                 TEXT PRIMARY KEY,                  -- uuid v4, used in the API
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id      BLOB NOT NULL UNIQUE,
    public_key         BLOB NOT NULL,
    sign_count         INTEGER NOT NULL DEFAULT 0,
    transports         TEXT NOT NULL DEFAULT '',          -- comma separated
    aaguid             BLOB,
    flags              INTEGER NOT NULL DEFAULT 0,        -- raw authenticator flags byte
    attestation_type   TEXT NOT NULL DEFAULT '',
    attestation_format TEXT NOT NULL DEFAULT '',
    name               TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    last_used_at       INTEGER,
    wrapped_mk_prf     TEXT                               -- opaque client JSON, NULL when PRF not set up
);
CREATE INDEX credentials_user ON credentials(user_id);

CREATE TABLE sessions (
    id_hash      BLOB PRIMARY KEY,                        -- SHA-256 of the cookie token
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state        TEXT NOT NULL CHECK (state IN ('mfa_pending', 'full')),
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE entries (
    id          TEXT PRIMARY KEY,                         -- client uuid v4
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    version     INTEGER NOT NULL,
    header_nonce BLOB NOT NULL,
    header_ct    BLOB NOT NULL,
    body_nonce   BLOB NOT NULL,
    body_ct      BLOB NOT NULL
);
CREATE INDEX entries_user_created ON entries(user_id, created_at DESC);

CREATE TABLE blobs (
    id         TEXT PRIMARY KEY,                          -- client uuid v4
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id   TEXT,                                      -- owning entry (may be uploaded before the entry is first saved)
    nonce      BLOB NOT NULL,
    data       BLOB NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX blobs_user ON blobs(user_id);
CREATE INDEX blobs_entry ON blobs(entry_id);

CREATE TABLE settings (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    nonce      BLOB NOT NULL,
    ct         BLOB NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE recovery_tokens (
    token_hash BLOB PRIMARY KEY,                          -- SHA-256 of the token
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);
CREATE INDEX recovery_tokens_user ON recovery_tokens(user_id);
