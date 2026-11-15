-- The whole schema as it stands after SQLite's migrations 0001-0007, for Postgres (which was
-- added at that point, so it has no earlier history to replay). From 0008 on, each schema
-- change is a file with the same number in both folders. All timestamps are unix
-- milliseconds (UTC).

CREATE TABLE users (
    id                  TEXT PRIMARY KEY,                 -- uuid v4
    username            TEXT NOT NULL,                    -- unique whatever the case: users_username
    note                TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
    is_admin            INTEGER NOT NULL DEFAULT 0,
    webauthn_handle     BYTEA NOT NULL UNIQUE,            -- random 32-byte WebAuthn user handle
    kdf_salt            BYTEA NOT NULL,
    kdf_m               INTEGER NOT NULL,
    kdf_t               INTEGER NOT NULL,
    kdf_p               INTEGER NOT NULL,
    auth_hash           TEXT NOT NULL,                    -- argon2id(authKey) PHC string
    recovery_hash       TEXT NOT NULL,                    -- argon2id(recoveryAuthKey) PHC string
    wrapped_mk_pass     TEXT NOT NULL,                    -- opaque client JSON
    wrapped_mk_recovery TEXT NOT NULL,                    -- opaque client JSON
    totp_secret_enc     BYTEA,                            -- AES-GCM(secret.key) of enabled secret
    totp_pending_enc    BYTEA,                            -- AES-GCM(secret.key) of secret awaiting confirmation
    last_totp_step      BIGINT NOT NULL DEFAULT 0,        -- replay protection
    created_at          BIGINT NOT NULL,
    approved_at         BIGINT,
    last_active_at      BIGINT,
    -- Sync change feed (SPEC §5.2): the user's write counter, and the seq at or below which
    -- tombstones were pruned (a device whose cursor is older must resync).
    sync_seq            BIGINT NOT NULL DEFAULT 0,
    tombstone_floor     BIGINT NOT NULL DEFAULT 0,
    -- Billing (SPEC §5.6). Only Stripe ids and dates are stored.
    comped              INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id  TEXT,
    sub_status          TEXT NOT NULL DEFAULT '',
    sub_period_end      BIGINT NOT NULL DEFAULT 0,
    sub_cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    -- Escalating TOTP lockout (SPEC §5.1 "Rate limits").
    totp_fail_count        INTEGER NOT NULL DEFAULT 0,
    totp_fail_window_start BIGINT NOT NULL DEFAULT 0,
    totp_locked_until      BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX users_username ON users (lower(username));
CREATE UNIQUE INDEX users_stripe_customer ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE credentials (
    id                 TEXT PRIMARY KEY,                  -- uuid v4, used in the API
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id      BYTEA NOT NULL UNIQUE,
    public_key         BYTEA NOT NULL,
    sign_count         BIGINT NOT NULL DEFAULT 0,
    transports         TEXT NOT NULL DEFAULT '',          -- comma separated
    aaguid             BYTEA,
    flags              INTEGER NOT NULL DEFAULT 0,        -- raw authenticator flags byte
    attestation_type   TEXT NOT NULL DEFAULT '',
    attestation_format TEXT NOT NULL DEFAULT '',
    name               TEXT NOT NULL,
    created_at         BIGINT NOT NULL,
    last_used_at       BIGINT,
    wrapped_mk_prf     TEXT                               -- opaque client JSON, NULL when PRF not set up
);
CREATE INDEX credentials_user ON credentials(user_id);

CREATE TABLE sessions (
    id_hash      BYTEA PRIMARY KEY,                       -- SHA-256 of the cookie token
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state        TEXT NOT NULL CHECK (state IN ('mfa_pending', 'full')),
    created_at   BIGINT NOT NULL,
    expires_at   BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    auth_at      BIGINT NOT NULL DEFAULT 0,               -- when the session last proved a credential
    mfa_failures INTEGER NOT NULL DEFAULT 0               -- wrong second-step answers while mfa_pending
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE entries (
    id           TEXT PRIMARY KEY,                        -- client uuid v4
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL,
    version      BIGINT NOT NULL,
    header_nonce BYTEA NOT NULL,
    header_ct    BYTEA NOT NULL,
    body_nonce   BYTEA NOT NULL,
    body_ct      BYTEA NOT NULL,
    seq          BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX entries_user_created ON entries(user_id, created_at DESC);
CREATE INDEX entries_user_seq ON entries(user_id, seq);

CREATE TABLE blobs (
    id         TEXT PRIMARY KEY,                          -- client uuid v4
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id   TEXT,                                      -- owning entry (may be uploaded before the entry is first saved)
    nonce      BYTEA NOT NULL,
    data       BYTEA NOT NULL,
    size       INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    seq        BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX blobs_user ON blobs(user_id);
CREATE INDEX blobs_entry ON blobs(entry_id);
CREATE INDEX blobs_user_seq ON blobs(user_id, seq);

CREATE TABLE settings (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    nonce      BYTEA NOT NULL,
    ct         BYTEA NOT NULL,
    updated_at BIGINT NOT NULL,
    seq        BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE tombstones (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('entry', 'blob')),
    item_id    TEXT NOT NULL,
    seq        BIGINT NOT NULL,
    deleted_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, kind, item_id)
);
CREATE INDEX tombstones_user_seq ON tombstones(user_id, seq);

CREATE TABLE recovery_tokens (
    token_hash BYTEA PRIMARY KEY,                         -- SHA-256 of the token
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at    BIGINT
);
CREATE INDEX recovery_tokens_user ON recovery_tokens(user_id);

-- Invite codes (SPEC §5.6). Only a SHA-256 of the code is stored.
CREATE TABLE invites (
    id         TEXT PRIMARY KEY,                                  -- uuid v4, used in the API
    code_hash  BYTEA NOT NULL UNIQUE,                             -- sha256(normalized code)
    note       TEXT NOT NULL DEFAULT '',                          -- who it's for, as the admin wrote it
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT NOT NULL,
    used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
    used_at    BIGINT                                             -- set once; a deleted user's code stays used
);
