# Kagimo — build spec (contract between backend and frontend)

A self-hosted, end-to-end encrypted journal. Go backend + SQLite, React frontend.
**Offline-first (§10):** the journal lives on the device (IndexedDB, ciphertext only) and works with no account and no
network; the server is an optional sync mirror for accounts that turn sync on.
The server must never see plaintext entries, entry metadata (title, location…), images,
user settings, or the user's passphrase. Visual design: `design/*.dc.html` (see §8).

## 1. Repository layout

```
backend/                 Go module `journal` (go 1.27)
  cmd/journal/main.go    server + admin CLI subcommands
  internal/...           store (sqlite), auth, webauthn, totp, api, admin
  web/embed.go           //go:embed all:dist  -> serves SPA (index.html fallback)
  web/dist/              Vite build output, gitignored except `.gitkeep` (re-created by the Vite build) so a
                         fresh checkout compiles; without a built index.html the server serves web/placeholder.html
frontend/                Vite + React 18 + TypeScript; build outDir = ../backend/web/dist
deploy/                  Caddyfile, systemd unit, helper scripts
desktop/                 Tauri app (Rust, system web view): the same frontend (built with `--mode desktop` into
                         desktop/renderer), with the journal kept in a folder of files (§11)
e2e/                     API-level end-to-end test (Node 22, uses real client crypto) + Chromium smoke test
design/                  design boards (read-only reference)
Makefile                 make dev / build / test / run
```

## 2. Runtime config (flags, each with env fallback)

| flag | env | default |
|---|---|---|
| `-addr` | `JOURNAL_ADDR` | `127.0.0.1:8080` |
| `-data` | `JOURNAL_DATA` | `./data` (holds `journal.db`, `secret.key`) |
| `-origin` | `JOURNAL_ORIGIN` | `http://localhost:8080` (full origin used for WebAuthn + Origin checks) |
| `-rp-id` | `JOURNAL_RP_ID` | host part of origin |
| `-rp-name` | `JOURNAL_RP_NAME` | `Kagimo` |
| `-downloads` | `JOURNAL_DOWNLOADS` | unset = none. A folder of desktop app installers (§11): the newest `.AppImage`, `.dmg` and `.exe` in it are listed in `/api/config` as `downloads: [{platform, name, size}]`, served at `GET /download/{name}` (only those names; attachment) and offered on the front page |
| `-downloads-repo` | `JOURNAL_DOWNLOADS_REPO` | unset. A GitHub repository `owner/name`: replaces `-downloads` with the installers of its latest release (asked of the GitHub API at most every 10 min, every 1 min after a failure, keeping the last good list; the first `/api/config` after a start waits up to 2 s for it). Each entry gains `url`, its `https://github.com/<repo>/releases/download/…` link (other links are dropped); the front page links there and `GET /download/{name}` redirects (302) to it |
| — | `JOURNAL_DATABASE_URL` | unset = SQLite (`journal.db` in the data directory). A `postgres://` URL = that Postgres database instead (env only, never a flag: it carries the password); see §6 |
| — | `STRIPE_SECRET_KEY` | unset = billing off (env only, never a flag). `sk_test_…` for test mode |
| — | `STRIPE_WEBHOOK_SECRET` | unset = webhook endpoint off; subscriptions are then only synced by the client |
| — | `GOMEMLIMIT` | Go runtime soft memory limit (unset = none); `deploy/journal.service` sets `256MiB` |
| `-price-month-cents` / `-price-year-cents` / `-price-currency` | `JOURNAL_PRICE_MONTH_CENTS` / `_YEAR_CENTS` / `_CURRENCY` | `0` / `1500` / `aud` (0 = interval not offered; yearly only by default) |
| `-paid-storage-mb` | `JOURNAL_PAID_STORAGE_MB` | `100`: fair-use cap for subscribed and comped accounts (admins uncapped) |

`secret.key`: 32 random bytes created on first start (0600). Used for: encrypting TOTP
secrets at rest (AES-GCM), HMAC for fake KDF salts of unknown usernames, HMAC of the recognised-device
cookie `jdev` (§5.1). Each use has its own HKDF-derived subkey.

Reference self-hosting: kagimo.local behind Caddy (`tls internal`) → `127.0.0.1:8080`, origin
`https://kagimo.local`. The `Dockerfile` builds the same server as a container image that keeps its data in a
volume at `/data`.
WebAuthn + WebCrypto require a secure context: `http://localhost` for dev, HTTPS otherwise.

Admin CLI: `journal admin list`,
`journal admin promote <username>`, `journal admin disable <username>`, `journal admin invite [note]` (prints a new
invite code, §5.6) (operate on the DB directly).
Bootstrap: the **first** account created on an empty DB becomes admin; every later account is `active` as soon as it is
created (there is no approval step). Like every
admin, it can only use the journal and the admin API once it has a second factor (§5.1 "Second factor"). For members a
second factor is optional.

Libraries: `modernc.org/sqlite` (pure Go, no cgo), `github.com/jackc/pgx/v5` (Postgres, through `database/sql`), `github.com/go-webauthn/webauthn`,
`golang.org/x/crypto/argon2`, stdlib `net/http` ServeMux (Go 1.22+ patterns). TOTP (RFC 6238, HMAC-SHA1) and uuid v4
are small stdlib-only packages in the repository (`internal/auth/totp.go`, `internal/uuid`), not dependencies.
SQLite: WAL mode, `foreign_keys=ON`, `busy_timeout=5000`, migrations embedded and versioned.

## 3. Cryptography (all content crypto is client-side, WebCrypto + `hash-wasm` argon2id)

Encoding: all binary in JSON is **standard base64 with padding**, except WebAuthn credential IDs
and WebAuthn JSON fields, which follow the WebAuthn JSON (base64url) conventions of the library.

**Passphrase → keys**
- `root = Argon2id(passphrase, salt=16 random bytes, m=65536 KiB, t=3, p=1, len=32)`
- `authKey = HKDF-SHA256(root, salt=∅, info="journal/auth/v1", 32 bytes)` → sent to server
- `kek = HKDF-SHA256(root, salt=∅, info="journal/kek/v1")` → AES-256-GCM key, never leaves client
- The passphrase and `root` never leave the browser.
- The client refuses KDF parameters it receives from the server (prelogin, `/api/me`) outside
  `m ∈ [65536, 1048576]`, `t ∈ [3, 16]`, `p ∈ [1, 16]`, salt 16–64 bytes, before deriving or sending anything:
  otherwise a hostile server could downgrade the KDF (e.g. `m=8, t=1`) and brute-force the `authKey` it receives.
  The server enforces the same bounds on sign-up, passphrase change and recovery reset.

**Master key (MK)**: 32 random bytes generated at sign-up. Wrapped copies stored server-side:
- `wrappedMkPass = AES-GCM(kek, nonce12, MK, AAD="journal/mk/v1")`
- Recovery key: 20 random bytes, shown as 32 Crockford-base32 chars in 8 groups of 4 (`K7QF-2M9D-…`).
  `recRoot = those 20 bytes`; `recoveryAuthKey = HKDF(recRoot, salt="journal/recovery/v1", info="auth")`;
  `recKek = HKDF(recRoot, salt="journal/recovery/v1", info="kek")`;
  `wrappedMkRecovery = AES-GCM(recKek, nonce12, MK, AAD="journal/mk/v1")`.
- Passkey PRF (optional, when authenticator supports the WebAuthn `prf` extension): PRF evaluated with the
  constant salt `SHA-256("journal/prf-salt/v1")` (see §5). `prfKek = HKDF(prfOutput, salt=∅, info="journal/prf-kek/v1")`;
  `wrappedMkPrf = AES-GCM(prfKek, nonce12, MK, AAD="journal/mk/v1")`.

**Content key**: `ck = HKDF(MK, salt=∅, info="journal/content/v1")` (AES-256-GCM, non-extractable).
Every ciphertext uses a fresh random 12-byte nonce. Ciphertext object shape in JSON: `{"nonce": b64, "ct": b64}`.
AAD binds ciphertext to its slot:
- entry header: `entry:<entryId>:header` · entry body: `entry:<entryId>:body`
- blob (image): `blob:<blobId>` · settings: `settings:<userId>` (a journal without sync uses its local vault id in place of
  `<userId>`; turning sync on re-seals the settings under the account id)
- the recovery key's server credential kept on the device for turning sync on later: `vault:<vaultId>:recovery-auth`

**Server-side auth secrets**: server stores `argon2id(authKey, serverSalt16, m=19456, t=2, p=1)` and
same for `recoveryAuthKey`; compare in constant time. TOTP secrets encrypted with `secret.key`.

**In-browser key lifetime**: the unwrapped MK lives in memory (JS module scope). Closing the tab or locking = locked.
Auto-lock after the configured idle time (settings `autoLock`: 1, 5 (default), 15 or 60 minutes, or 0 = never; the last
choice is also kept in localStorage `wordsafe.autoLock`, not sensitive, so it applies from the moment of unlocking).
Activity is pointer, key, wheel, scroll, touch, `input`/`change` and `focusin` events anywhere in the page.
**Reload keeps it open**: while unlocked, the MK is also sealed (AES-256-GCM, AAD `resume:<vaultId>`) under a fresh
*non-extractable* AES key; the key is stored in IndexedDB `meta` (`resume:<token>`), the sealed MK, token and last
activity time in that tab's sessionStorage (`kagimo.resume`). Browsers bring a closed tab's sessionStorage back
("reopen closed tab", session restore), so the copy opens the journal only for an actual reload: on `pagehide` the page
records `unloadedAt`, and the copy is used only when the navigation type is `reload`, the load starts within 15 s of
`unloadedAt`, and the idle limit hasn't passed (back from the bfcache: the idle limit alone, since the page never left
memory). Anything else (a restored or duplicated tab, a URL typed into the tab, a crash, a later reload) deletes the
copy and asks for the passphrase. Locking (by hand or idle) deletes both halves. Each unlocked tab holds a Web Lock
named after its key; on start the app deletes every reload key whose lock isn't held (by age, 1 day, without Web
Locks), and removing the journal from the device deletes them all. A new tab, or a reload while locked (even
PIN-locked), needs the passphrase.
No MK, kek, or passphrase in localStorage/sessionStorage/IndexedDB in usable form: IndexedDB holds the *wrapped* MK,
ciphertext, and only non-extractable CryptoKeys (reload key above; device key for a journal without a password, §10).
Non-extractable limits what scripts can read, not what is on disk: while a journal is unlocked (and until the next
start of the app after a tab is closed without locking) the reload key and the sealed MK are both in the browser
profile, so someone who can read the profile's files at that time can recover the MK.

**PIN unlock** (optional, settings `pin`): the MK sealed under `Argon2id(PIN, salt16, m=64 MiB, t=3, p=1)` with AES-256-GCM,
AAD `pin-unlock:v1`. The wrap is kept only inside the encrypted settings (so it syncs, and reading it needs CK already).
PIN: 6–8 digits (4–8 for PINs set before the minimum was raised), not one repeated digit or a ±1 run; setting or
changing it asks for the passphrase (checked against the device's wrapped MK). While unlocked the key store holds the wrap; locking (idle or
manual) drops MK and CK but keeps the wrap in memory, and the unlock page then asks for the PIN. The PIN stops working,
and the passphrase or a PRF passkey is needed, once `pin.fullUnlockAfter` minutes have passed since the last activity
while unlocked (checked against wall-clock time; an idle lock already past it is a full lock), after 5 wrong PINs, on
reload/close or bfcache, when the journal is removed from the device, and when the update banner reloads. Passphrase and passkey unlock always work too.

## 4. Plaintext payload shapes (only ever exist in the browser)

Entry header (small; all headers are fetched to build the list and to search locally):
```json
{"v":1,"title":"…","snippet":"first ~160 chars of text","createdAt":"2026-11-11T21:40:00+00:00",
 "tz":"Europe/London","location":{"label":"Clifton, Bristol","precision":"neighbourhood"} | null,
 "wordCount":412,"imageCount":1,"coverBlobId":"<blobId of the first image>" | null,"photoCount":1,
 "weather":{"code":3,"day":true,"tempC":11.4} | null}
```
`weather` (optional, added later; missing reads as `null`): WMO weather code, day/night and °C when the entry was started.
`coverBlobId` (the timeline thumbnail) and `photoCount` were added later: headers saved before them lack both, and the
client then shows no thumbnail (and counts `imageCount` as photos) until the entry is next saved.
Entry body: `{"v":1,"doc": <TipTap/ProseMirror JSON>}`. Images in the doc are a custom node
`encryptedImage` with attrs `{blobId, alt, caption, width, height}`; rendered by fetching the blob,
decrypting, and using an object URL.

Settings: `{"v":1,"mode":"system|light|dark","lightTheme":"paper","darkTheme":"paper-dark",
"customThemes":[{id,name,kind:"light|dark",tokens:{…}}],"details":{"datetime":true,"location":"off|city|neighbourhood","weather":false},
"writing":{"font":"newsreader","size":"large","leading":"comfortable"},"autoLock":5}`
`autoLock` (added later; missing or unknown reads as 5): minutes without activity before the journal locks, one of
`1 5 15 60`, or `0` for never (closing the tab still locks).
`pin` (optional, added later; missing or malformed reads as `null` = off): `{"salt":"…","nonce":"…","ct":"…",
"fullUnlockAfter":60}` (§3, base64 lengths 16/12/48 bytes); `fullUnlockAfter` ∈ `15 60 240 720 1440` minutes, unknown → 60.
`returnDividers` (optional, added later; missing reads as `true`): automatic dividers when coming back to an entry.
`books` (optional, added later; missing reads as `{}`): `{"2025": {"title": "The year we moved", "cloth": "oxblood"}}`,
year book covers keyed by year; `title` ≤ 80 characters, `cloth` ∈ `ink oxblood bottle ochre plum linen` (unknown → `ink`).
A year without an entry gets an untitled cover in a cloth chosen from the year.
`writing` (global, not per theme): `font` ∈ `newsreader eb-garamond cormorant-garamond libre-caslon literata
source-serif-4 fraunces inter ibm-plex-sans ibm-plex-mono`, `size` ∈ `small medium large xlarge`, `leading` ∈
`compact comfortable airy`. Missing (settings saved before it existed) or unknown values read as the defaults shown.

Entry docs may contain, besides StarterKit nodes: headings of level 1–3 (Title, Heading, Subheading), a `highlight`
mark (single colour, no attrs), `textAlign: "center"` on paragraphs and headings (left is the default and is stored
as `null`), and `horizontalRule` (the section divider), with an optional `at` attr: an ISO time with offset, set only on dividers
added automatically when writing resumes later (below); missing or `null` on ordinary ones.

Images: before upload the client re-encodes via canvas (strips EXIF/GPS), max 2560px long edge, JPEG q≈0.88
(PNG kept as PNG if it has transparency), then encrypts. Max ciphertext upload 15 MB.

## 5. HTTP API

JSON in/out. Session cookie `jsid` (HttpOnly, SameSite=Strict, Secure when origin is https, Path=/,
30-day expiry, rotated on login; stored hashed server-side). **All non-GET requests must carry header
`X-Journal: 1` and an `Origin` equal to the configured origin** (else 403). Errors: `{"error":"code","message":"…"}`
with proper status codes. Rate-limit login/prelogin/recover/totp per IP+username (e.g. 10/min) → 429.

Session states: `mfa_pending` (passphrase OK, second factor — TOTP or passkey — needed) and `full`.
Admins who have no second factor yet get a full session but only the "any status" endpoints below (403 `second_factor_required` elsewhere, see §5.1 "Second factor").

### Public
- `GET /api/config` → `{rpId, rpName, bootstrap: bool /* no users yet */, returning: bool /* well-formed, unexpired jdev cookie present (MAC not checked; landing-page hint only) */}`
- `POST /api/auth/prelogin {username}` → `{kdf:{salt,m,t,p}}` — for unknown usernames return a
  deterministic fake salt (HMAC(secret, username)) with the same params; same timing.
- `POST /api/auth/login {username, authKey}` → one of (all `200`; see §5.1 "Passphrase sign-in" for the exact rules):
  - `{status:"ok", me}` — full session; only for accounts with **no** second factor yet;
  - `{status:"totp_required"}` — TOTP enabled, no passkeys (sets an `mfa_pending` session);
  - `{status:"totp_required", passkeyAllowed:true}` — TOTP and passkeys: either second step completes it (`mfa_pending`);
  - `{status:"passkey_required"}` — passkeys, no TOTP (`mfa_pending`).
- `POST /api/auth/login/totp {code}` (mfa_pending session) → `{status:"ok", me}` (full session, rotated)
- `POST /api/auth/login/passkey/begin` (mfa_pending session, no body) → `{challengeId, options}`: a WebAuthn
  assertion request with `allowCredentials` = the session user's passkeys and `userVerification:"required"`.
- `POST /api/auth/login/passkey/finish {challengeId, credential}` (mfa_pending session) → `{status:"ok", me}`
  (full session, rotated). The assertion must come from one of the session user's own passkeys.
- `POST /api/auth/passkey/begin` → `{challengeId, options}` (discoverable login, empty allowCredentials).
  The client adds `extensions.prf.eval.first = PRF_SALT` itself, where `PRF_SALT = SHA-256("journal/prf-salt/v1")`
  is a **constant for all credentials** (the PRF output is still unique per credential). The server stores
  only the wrapped MK per credential (`wrappedMkPrf`). This supersedes the per-credential `prfSalt` in §3.
- `POST /api/auth/passkey/finish {challengeId, credential}` → `{status:"ok", me}` (passkey = full login, no TOTP).
  Because it replaces passphrase + TOTP, passkey sign-in requires user verification (`userVerification: "required"`;
  assertions without the UV flag are refused with `passkey_failed`).
- `POST /api/signup {username, note, kdf:{salt,m,t,p}, authKey, recoveryAuthKey, wrappedMkPass, wrappedMkRecovery, invite?}`
  → `{me}` + session. Username: 3–32 chars `[a-z0-9._-]`, case-insensitive unique. Note: ≤ 500 characters, single
  line, no control characters (C0/C1 incl. newline, tab, ESC) and no bidi formatting characters
  (U+061C, U+200E/F, U+202A–202E, U+2066–2069), else `400 invalid_note`. Passphrase strength is
  enforced client-side (§8.1 "Passphrase policy"): an estimate of at least 60 bits. `invite`: an admin-minted code
  (case, dashes and spaces ignored); the account is created `comped` and the code is used up, in one transaction. An
  unknown, withdrawn or used code → `400 invalid_invite` and no account is created.
- `POST /api/auth/recover/verify {username, recoveryAuthKey, totpCode?}` → `{token, wrappedMkRecovery}`
  (TOTP required if the account has it enabled; token valid 10 min, single use)
- `POST /api/auth/recover/reset {token, kdf, authKey, wrappedMkPass}` → `{status:"ok", me}` + session.
  Recovery tokens are revoked (all of the user's, used or not) by a completed reset, a passphrase change and a
  recovery-key rotation.
- `POST /api/auth/logout`
- `POST /api/auth/reauth {authKey}` (full session) → `{status:"ok"}`: re-proves the passphrase for the current session;
  see "Re-authentication" in §5.1.

### Any authenticated user
- `GET /api/me` → `{id, username, status:"active"|"disabled", isAdmin, totpEnabled,
  passkeys:[{id, name, createdAt, lastUsedAt, prf:boolean}], hasSecondFactor,
  keys:{kdf:{salt,m,t,p}, wrappedMkPass, passkeyWraps:[{credentialId /*b64url*/, wrappedMk}]}}`
- `POST /api/passkeys/register/begin {name}` → `{challengeId, options}` (resident key required, userVerification preferred)
- `POST /api/passkeys/register/finish {challengeId, name, credential}` → `{passkey}`. An account holds at most 20
  passkeys: `begin` and `finish` answer 409 `passkey_limit` past that.
- `PUT /api/passkeys/{id}/prf {wrappedMk}` — client calls this after a follow-up `get()` with the PRF salt
  confirms PRF works (create() often reports `prf.enabled` without results).
- `PATCH /api/passkeys/{id} {name}` · `DELETE /api/passkeys/{id}` (refused with 409 `last_second_factor` only for an active **admin** whose last second factor it is; members may remove theirs)
- `POST /api/totp/setup` → `{secret, otpauthUrl}` (issuer = rpName) · `POST /api/totp/enable {code}` · `POST /api/totp/disable {code}`
  TOTP: 30s, 6 digits, ±1 step skew, reject reuse of an already-used step.
- `POST /api/account/passphrase {currentAuthKey, kdf, authKey, wrappedMkPass}`
- `POST /api/account/recovery {recoveryAuthKey, wrappedMkRecovery}` (regenerate recovery key; requires full session
  **and recent authentication**, see §5.1)

### Active users only (admins 403 `second_factor_required` without a passkey/TOTP)
- `GET /api/entries` → `[{id, createdAt, updatedAt, version, header:{nonce,ct}}]` (server timestamps, newest first;
  one array, streamed from the database a page at a time so the response is never built in memory whole)
- `GET /api/entries/{id}` → `{id, createdAt, updatedAt, version, header, body}`
- `POST /api/entries {id /*client uuid v4*/, header, body}` → `{id, version:1, createdAt, updatedAt, seq}`
- `PUT /api/entries/{id} {header, body, baseVersion}` → `{version, updatedAt, seq}`; 409 `version_conflict` if stale.
  On create and update `header.ct` may be at most 64 KiB (413 `header_too_large`; a real header is under 1 KB); the
  body is bounded by the 1 MB JSON limit.
- `DELETE /api/entries/{id}` (also deletes its blobs)
- `POST /api/blobs` → always **410** `photos_unsupported`. Kagimo stores text only; photos stored before uploads
  stopped can still be read and deleted, and the client no longer uploads any (ones only on a device stay there).
- `GET /api/blobs/{id}` → raw bytes, header `X-Blob-Nonce: <b64>`, `Cache-Control: private, max-age=31536000, immutable`
- `DELETE /api/blobs/{id}`
- `GET /api/settings` → `{nonce, ct}` or 204 · `PUT /api/settings {nonce, ct}`
All entry/blob/settings access is scoped to the session user; foreign IDs → 404.

### Admin only (active admin with a second factor; 403 `forbidden`, or `second_factor_required`)
The `POST` and `DELETE` routes here also need recent authentication (403 `reauth_required`, §5.1 "Re-authentication").
- `GET /api/admin/users` → `[{id, username, note, status, isAdmin, createdAt, approvedAt, lastActiveAt,
  storageBytes, passkeyCount, totpEnabled, hasSecondFactor, plan, freeBytes}]` (`plan` and `freeBytes` as in §5.6)
- `POST /api/admin/users/{id}/disable` · `/enable` · `DELETE /api/admin/users/{id}` (cannot act on self). With billing
  on, deleting an account that has a Stripe customer also cancels its subscriptions there (best effort after the
  delete: a Stripe failure is logged with the customer id and does not fail the request).
- `GET /api/admin/stats` → `{members, storageBytes}`
- `POST /api/admin/users/{id}/comp` · `/uncomp`: grant or remove unlimited free use (billing, §5.6)
- `GET /api/admin/invites` → `[{id, note, createdAt, usedAt, usedBy}]` (newest first; `usedBy` is the username, `""` if
  unused or since deleted) · `POST /api/admin/invites {note?}` → the same plus `code` (`XXXX-XXXX-XXXX-XXXX`, Crockford
  base32, 80 bits; shown only here, the server keeps a SHA-256) · `DELETE /api/admin/invites/{id}` (unused only; else
  409 `invite_used`). No limit on how many. A used code stays used even if its account is deleted.

### 5.6 Billing (optional; on when `STRIPE_SECRET_KEY` is set)
- Plans: a `free` account syncs for free for `freeDays` from when it was created (`-free-sync-days`, default 30), and
  meanwhile may store `freeBytes` on the server (`-free-storage-kb`, default 450 KB = 450 000 bytes, roughly 170
  pages). Once the period is over its limit is 0, so it is `full` and nothing grows until it subscribes. It stores:
  its entries and settings as ciphertext. Photos stored before uploads stopped don't count (the admin view's storage
  does include them). Journals without sync
  (§10) are not limited; only what a signed-in account syncs counts. `admin`, `comped` (grandfathered by migration 0004,
  granted by an admin, or signed up with an admin's invite code) and `subscribed` accounts get `paidBytes` (`-paid-storage-mb`, default 100 MB, a fair-use cap);
  `admin` is uncapped. `subscribed` = Stripe status
  `active|trialing|past_due` and now < period end + 3 days. With billing off every account is `unlimited`.
- A write that makes a free account bigger and leaves it over its limit (`POST /api/entries`, `PUT /api/entries/{id}`,
  `PUT /api/settings`) → **402** `storage_full` `{freeBytes, usedBytes, freeOver}`, and nothing is stored.
  Writes that shrink the account or keep its size, deletions, reads and sync pulls are never limited, so deleting
  frees space and an account over the limit (a lapsed subscription) can still edit. A paid or comped account past
  `paidBytes` gets **413** `storage_limit` `{limitBytes, usedBytes}` under the same rules; the client queues the change
  but does not offer an upgrade.
- Device side: sync keeps a refused change queued on the device and sends the rest; the sync status becomes `full`
  ("Sync space full"), the upgrade dialog opens once per page load, and subscribing syncs again at once. Writing in the
  journal is never blocked.
- `GET /api/me` includes `billing: {enabled, plan, freeBytes, usedBytes, limitBytes, full, freeUntil, freeOver,
  status, periodEnd, cancelAtPeriodEnd, hasCustomer}` (`limitBytes`: this account's cap, -1 = none; `full`:
  `usedBytes >= limitBytes`; `freeUntil`/`freeOver`: the free period, free accounts only, else null/false);
  `GET /api/config` includes `billing: {enabled:false} | {enabled:true, freeBytes, freeDays, paidBytes,
  prices: [{amount, currency, interval}]}` (monthly first, then yearly; either may be switched off).
- Active users: `POST /api/billing/checkout {interval?: "month"|"year"}` → `{url}` (Stripe's hosted Checkout page
  for that price, default the first; 400 `bad_interval`; 409 `already_subscribed`; 400 `embedded_disabled` for a
  request with `embedded: true`, which no longer exists) ·
  `POST /api/billing/portal` → `{url}` (Stripe customer portal; 409 `no_subscription` without a customer) ·
  `POST /api/billing/sync` → `billing` (re-reads the subscription from Stripe). These call Stripe and are limited to
  30/min per user; Stripe failures → 502 `billing_unavailable`; billing off → 404 `billing_disabled`.
- `POST /api/billing/webhook`: Stripe events, verified by `Stripe-Signature` (HMAC-SHA256, 5-minute tolerance), exempt
  from the CSRF check. The event only names the customer; the server re-reads that customer's subscriptions, so
  duplicate and out-of-order events are harmless. Subscribe at least to `checkout.session.completed` and
  `customer.subscription.created|updated|deleted`.
- Privacy: Stripe receives the user's id (customer metadata) and whatever the customer types into Checkout; never the
  username or any content. The server stores only `stripe_customer_id`, subscription status, period end and
  cancel-at-period-end. Each price is found by lookup key `kagimo_<interval>_<currency>_<amount>` and created on first
  use, all on one product; the customer-portal configuration likewise.
- Checkout and the customer portal are Stripe's hosted pages, opened in a **new tab** (keys live only in the journal
  tab's memory); the app polls `/api/billing/sync` until the plan changes, and Stripe returns the customer to
  `/billing/done`. Stripe's script is never loaded in the app's origin: there is no publishable key, `/api/config`
  carries none, and the CSP (§7) is the same with billing on or off and names no Stripe origin.
- Call to action: signed-in, active free accounts see a banner across the top of the app with space used and a
  Subscribe button (opens the upgrade dialog). It can be hidden for the browser session; once the free space is full
  it becomes a warning that can't be hidden. Sync no longer opens the dialog by itself.

### 5.7 What the server sees, and what the device sent
Two pages under Settings → Sync & backup let a person check the claims in the README's threat model for themselves.

- **What the server sees** (`/settings/sync/server`, synced journals only) shows one entry side by side: the most
  recently changed entry on the device that is on the server (`version > 0`). Left, "On this device": its title, date,
  place, word count and text, decrypted in the browser from the device's copy. Right, "On our server": what
  `GET /api/entries/{id}` returns for it, fetched when the page opens, namely the header and body ciphertext in full
  (base64) with their sizes, the entry id, the server's first-saved and last-saved times, and the version. Nothing
  else, and no new endpoint. A hint says so when the device has changes to the entry that haven't synced; with nothing
  synced yet the page says that instead.
- **What this device sent** (`/settings/sync/sent`, any journal) lists every request the tab has made through the API
  client and to Open-Meteo since it loaded (`api/sentLog.ts`): time, method, address, body size, status, and the body
  with every string longer than 40 characters cut to its first 16 plus its length, so the log never holds a whole key,
  credential or ciphertext. In memory only, the last 300 requests; a reload starts it again. Files the browser loads
  itself (scripts, fonts, the places dataset) are not listed. It is the app reporting on itself; the page says so and
  points to the browser's Network tab as the independent check.

### 5.1 API details fixed by the backend implementation

These clarify §5 where it was ambiguous; the frontend and e2e test can rely on them.

- **Wrapped keys** (`wrappedMkPass`, `wrappedMkRecovery`, `wrappedMk`, `passkeyWraps[].wrappedMk`) are opaque to the
  server. Send them in the ciphertext object shape `{"nonce": b64, "ct": b64}` (a single base64 string is also accepted);
  the server validates and echoes them back verbatim.
- **WebAuthn `options`** returned by `…/begin` is the go-webauthn object `{"publicKey": {…}}` with base64url binary
  fields (`challenge`, `user.id`, `excludeCredentials[].id`) — usable with
  `PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey)` / `parseRequestOptionsFromJSON`.
  **`credential`** sent to `…/finish` is the `PublicKeyCredential.toJSON()` shape (base64url fields, `response.userHandle`
  required for passkey login).
- **Passkey objects** are `{id, credentialId /*b64url*/, name, createdAt, lastUsedAt, prf}`; `id` is a server uuid used in
  `/api/passkeys/{id}…` paths. `PATCH /api/passkeys/{id}` returns `{passkey}`.
- **Responses without a body in §5** (logout, PUT prf, DELETE passkey, totp enable/disable, account/*, admin actions)
  return `200 {"status":"ok"}`. DELETE entries/blobs and PUT settings return `200 {"status":"ok", seq}` (§5.2).
- **Timestamps** are RFC 3339 UTC with milliseconds, e.g. `2026-11-11T21:40:00.000Z`; nullable ones are `null`.
- **Error codes** (`{"error": code, "message": …}`): `bad_request`, `invalid_username`, `invalid_note` (400); `unauthenticated`,
  `invalid_credentials`, `invalid_totp`, `totp_required` (recover/verify without a code), `invalid_token`,
  `passkey_failed` (401); `csrf`, `second_factor_required`, `account_disabled`, `forbidden`,
  `reauth_required` (403); `not_found` (404);
  `username_taken`, `version_conflict` (+ `currentVersion`), `entry_exists`, `blob_exists`, `passkey_exists`,
  `last_second_factor`, `no_second_factor`, `invalid_status`, `totp_already_enabled`, `totp_not_setup`,
  `totp_not_enabled`, `no_mfa_pending`, `no_passkey`, `passkey_limit` (409); `storage_full` (402, §5.6); `too_large`, `header_too_large`, `storage_limit` (413, §5.6); `rate_limited`, `totp_locked`
  (+ `lockedUntil`) (429); `challenge_expired`, `webauthn_invalid`, `webauthn_failed` (400); `self_action` (400, admin
  acting on own account); `busy` (503, with `Retry-After`: the server is already computing as many Argon2 hashes as it
  allows at once, see "Rate limits"; retry after a few seconds).
- **Sessions:** an `mfa_pending` session lives 10 min and only allows `POST /api/auth/login/totp`,
  `POST /api/auth/login/passkey/begin` and `POST /api/auth/login/passkey/finish` (everything else → 401
  `unauthenticated`; those three with a full session → 409 `no_mfa_pending`, without any session → 401).
  Login of a disabled account → 403 `account_disabled`. Changing the passphrase signs out all *other* sessions;
  recovery reset signs out *all* sessions and starts a new one.
- **Passphrase sign-in** (`POST /api/auth/login`), after the passphrase is verified:

  | account has | response (200) | session | next step |
  |---|---|---|---|
  | neither TOTP nor passkey | `{status:"ok", me}` | full (restricted, see "Second factor") | set up a passkey or TOTP |
  | TOTP only | `{status:"totp_required"}` | mfa_pending | `/login/totp` |
  | passkey(s) only | `{status:"passkey_required"}` | mfa_pending | `/login/passkey/begin` + `/finish` |
  | TOTP and passkey(s) | `{status:"totp_required", passkeyAllowed:true}` | mfa_pending | either of the above |

  `passkeyAllowed` is present only when `true`. A pending response never contains `me`.
  Second step by passkey: `begin` → `{challengeId, options}` where `options` is `{"publicKey": {challenge, rpId,
  timeout, userVerification:"required", allowCredentials:[{type:"public-key", id /*b64url*/, transports?}]}}`
  (parse with `PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey)`; the client may add the PRF
  extension exactly as for discoverable sign-in to unlock in the same ceremony). `finish {challengeId, credential}`
  with `credential` = `PublicKeyCredential.toJSON()` (PRF outputs stripped). Errors: `begin` → 409 `no_passkey` (the
  account has no passkeys), 429 `rate_limited`; `finish` → 400 `challenge_expired` (unknown, expired,
  already used, or issued for another session user / for discoverable sign-in), 400 `webauthn_invalid` (malformed
  credential), 401 `passkey_failed` (not one of this user's passkeys, bad signature, no UV flag, sign-counter
  regression), 429 `rate_limited`. Each `passkey_failed` (like each `invalid_totp` on `/login/totp`) counts against
  the `mfa_pending` session: after 5 the session is deleted and the next call answers 401 `unauthenticated` — start
  again from the passphrase. `/login/totp` on an account without TOTP → 409 `totp_not_enabled`. Success on either
  step deletes the `mfa_pending` session and sets a new full-session cookie (plus the `jdev` cookie).
- **Second factor:** optional for members. **Admins** must have TOTP enabled or at least one passkey for every route
  that needs an active account; otherwise 403 `second_factor_required` (checked after `forbidden`).
  This hits the bootstrap admin until it sets one up, and anyone promoted without one. They keep every "any status"
  endpoint (`/api/me`, passkey registration, TOTP setup, passphrase, recovery key), so the client routes a user with
  `me.isAdmin && !me.hasSecondFactor` to second-factor setup.
- **Recognised devices:** every full sign-in (passphrase without second factor, TOTP step, passkey step, discoverable
  passkey sign-in, recovery reset, sign-up) sets cookie `jdev` (HttpOnly, SameSite=Strict, Secure on https,
  `Path=/api/`, 1 year): a random device id plus expiry, HMAC-SHA256-authenticated together with the user id under a
  key derived from `secret.key`. It grants no access by itself; it only selects the failure counter for wrong
  passphrases (see "Rate limits"). One browser holds one `jdev` (the last account that signed in on it). It is not
  cleared on logout. Clients do nothing with it.
- **TOTP:** `setup` stores a pending secret; `enable {code}` confirms it. `disable` (like deleting the last passkey) is
  refused with `last_second_factor` for an active admin whose only second factor it is; members may remove their last.
- **Blobs:** `entryId` is optional and may name an entry that has not been saved yet; `DELETE /api/entries/{id}` deletes
  all of the user's blobs carrying that `entryId`. `nonce` is base64url (padding optional). `GET` also sets
  `Content-Type: application/octet-stream`. Maintenance deletes blobs older than 24 h that are not attached to an
  existing entry of their owner (no `entryId`, or the entry was never saved / was deleted before the upload landed).
  Each blob belongs to exactly one entry: the client copies (re-encrypts under a new blob ID) any image pasted from
  another entry instead of referencing the other entry's blob.
- **Admin:** `enable` only for `disabled` users; `disable` revokes sessions and recovery tokens. Accounts created
  while sign-up needed approval were made `active` by migration 0005.
- **Rate limits:** 10/min per IP+username per endpoint group (prelogin, login + reauth, totp, recover, passphrase), plus
  10/min per IP for signup, passkey login and recovery reset, plus 60/min per IP across all of these. The client IP is
  the right-most `X-Forwarded-For` entry only when the TCP peer is loopback (Caddy); otherwise the peer address.
  IPv6 clients are grouped by /64 for these limits. The second-step passkey endpoints share a 10/min per IP+username
  group. Usernames are normalised (trim, lower-case) and validated **before** they reach any limiter or map: raw
  input over 64 bytes or not matching `[a-z0-9._-]{3,32}` is replaced by one fixed key, so a malformed username never
  becomes a key (and simply gets `invalid_credentials` / a fake prelogin salt).
  On top of that, failures are counted **regardless of IP**:
  - **Wrong passphrases** (login, reauth, passphrase change): a request that carries a valid `jdev` cookie for that
    user is charged to that device's own bucket (10 per hour per device) and is **not** affected by the account-wide
    lock; every other request is charged to the account-wide bucket (30 per hour, keyed by username). Unknown (but
    well-formed) usernames go through the same account-wide counter, so the 401 → 429 sequence and the timing are the
    same whether or not the account exists. While the selected bucket is exhausted, even the right passphrase gets
    `429 rate_limited`. Net effect: someone who knows a username can lock out unrecognised browsers, not the owner's
    own devices.
  - **Wrong TOTP codes** (login, recovery, enable/disable): 5 per 10 minutes per account (`429 rate_limited`), plus an
    **escalating lockout** for the sign-in TOTP step and `totp/disable`: the 10th wrong code within 24 h locks TOTP for
    1 h, the 20th for 24 h (`429 totp_locked`, body includes `lockedUntil`, RFC 3339). The lockout applies to every
    caller, including recognised devices and correct codes; a correct code outside a lock resets the count. While
    locked, the owner can still finish sign-in with a passkey (when `passkeyAllowed`) or use account recovery:
    `recover/verify` is subject only to the 5-per-10-minutes limit, not the lockout.
  An `mfa_pending` session is deleted after 5 wrong second-step answers (codes or passkey assertions). When a limiter's
  table is full it evicts the least-used bucket instead of refusing everyone.
  **What survives a restart:** the escalating TOTP lockout (count, window start and locked-until, in the `users` row)
  and the wrong-answer count of each `mfa_pending` session (in its `sessions` row) are in the database (migration
  0007), so stopping the machine neither lifts a lock nor refills a session. The per-IP limits, the passphrase buckets
  and the 5-per-10-minutes TOTP bucket are in memory and start full again; every wrong code they then let through
  still counts towards the lockout.
  **Argon2 concurrency:** each server-side hash (login, reauth, sign-up, recovery, passphrase and recovery-key change)
  takes 19 MiB, so at most **3** run at once in the whole process. A request that finds all three busy waits up to 3 s
  (or until the client goes away), then gets `503 busy` with `Retry-After: 3`; nothing was checked or changed.
  `recover/reset` looks its token up before hashing, so an invalid token costs no hash.
- **Re-authentication:** every full session records when it last proved a credential (sign-up, passphrase or passkey
  sign-in, TOTP step, recovery reset, passphrase change, `POST /api/auth/reauth`). These endpoints additionally require
  that to be within the last **10 minutes** (shorter than the 15-minute idle auto-lock), else `403 reauth_required`: `POST /api/passkeys/register/begin`,
  `PUT /api/passkeys/{id}/prf`, `DELETE /api/passkeys/{id}`, `POST /api/totp/setup`, `POST /api/totp/enable`,
  `POST /api/account/recovery`, and every admin `POST`/`DELETE` (`/api/admin/users/{id}/{disable,enable,comp,uncomp}`,
  `DELETE /api/admin/users/{id}`, `POST /api/admin/invites`, `DELETE /api/admin/invites/{id}`). (`register/finish` is bound to a challenge only issued under recent auth;
  `totp/disable` and `account/passphrase` prove a credential in the request.) A session cookie alone therefore cannot
  install a recovery key, passkey or TOTP secret of an attacker's choosing, nor (an admin's) disable, delete or comp
  accounts or mint invites. The client answers `reauth_required` by
  asking for the passphrase, calling `/api/auth/reauth` and retrying the request.

### 5.2 Sync (change feed)

`GET /api/sync?since=<cursor>` (active users with a second factor) →
`{cursor, more, entries:[{id, createdAt, updatedAt, version, header, body}], blobs:[{id, entryId?, size}],
deleted:{entries:[ids], blobs:[ids]}, settings: {nonce, ct} | null}`.
- Every write to a user's entries, blobs or settings takes the next value of the user's `sync_seq` and stores it on the
  row; deleting an entry or blob leaves a tombstone (`tombstones`: only kind, id and seq; no content) with its own seq.
  The page holds everything with `since < seq <= cursor`. A page ends after 100 entries (with bodies) or, sooner,
  before the entry that would take its header and body ciphertext past 4 MiB (a page always has at least one entry
  when any remain), with `more: true` when there is another: clients follow `cursor` until `more` is false and must
  accept short pages. `since=0` is a full sync: the current state only, no tombstones.
- Tombstones older than 90 days are pruned by maintenance, raising the user's `tombstone_floor`. A user keeps at most
  5000: a deletion past that drops the oldest and raises the floor in the same way (deleting is never refused), so
  creating and deleting in a loop cannot grow the database. A cursor below the floor,
  or above the user's current seq (a restored database), answers **410 `cursor_expired`**: the device starts again from 0
  and treats anything it believed was on the server but didn't receive as deleted there.
- Blob bytes are fetched separately (`GET /api/blobs/{id}`); the feed carries metadata only.
- `POST /api/entries` may re-create an id that was deleted (a device kept editing it offline); its tombstone goes.
- Every content write (entry create/update/delete, blob delete, settings) answers with the `seq` it took. A device whose
  writes come back as cursor+1, +2, … knows nobody else wrote in between and moves its cursor past them, instead of
  downloading its own changes again.

**Device side.** Sync runs in the background while the journal is unlocked (merges need the content key): on unlock,
every minute while the tab is visible (a hidden tab doesn't poll), when the tab becomes visible, when the browser comes
back online, and after local changes: 10 s after the latest, but no more than 30 s after the first unpushed one. Hiding
the tab saves open editors and pushes straight away. One run: pull the feed → push queued deletions, then changed
entries (`POST`, or `PUT` with the base version), then settings → pull again, unless nothing was pushed or the
returned seqs followed the cursor without a gap → download images not on the device yet (3 at a time). Settings are
last-writer-wins (unpushed local changes win).

**Conflicts.** Each device keeps, per entry, the server copy its version is based on (`base`). When a newer server copy
meets unpushed local changes (in the feed, or as the 409 answer to a push, re-fetched with `GET /api/entries/{id}`):
- header fields `title`, `createdAt`, `tz`, `location`, `weather` merge field by field: changed on one side → that side; on both →
  the more recent edit (local edit time vs server `updatedAt`). Derived fields (snippet, counts, cover) are recomputed;
- the body merges three ways over top-level blocks (paragraphs, headings, images, lists…): changes are hunks of base
  blocks replaced by one side (n blocks rewritten into n blocks count as n one-block hunks); hunks of one side only
  apply; additions by both sides at the same spot are both kept (this device's first); identical changes apply once;
  only hunks of both sides touching the same base blocks are a **conflict**;
- a clean merge is saved and pushed; a conflict is stored on the entry (`conflict: {theirs, base, kind:'edit'}`) and
  nothing of it is pushed until the person settles it on the conflict screen (per passage: this device's, the other's,
  or both; or all one side; or "keep both as separate entries", which copies the other version, images re-encrypted
  under new ids, into a new entry);
- an entry deleted on the server while this device has unpushed changes (or has it open) becomes a conflict of kind
  `deleted`: keep it (created again on the server) or burn it here too;
- an entry open in an editor is never rewritten underneath it: the newer copy waits (`incoming`) until the editor has
  saved its last keystrokes and, with editing paused, takes it in.

## 6. Database (SQLite, or Postgres)

SQLite is the default and what this section describes. With `JOURNAL_DATABASE_URL` set the same store runs on
Postgres: one implementation, whose queries go through a small dialect layer (`internal/store/dialect.go`:
placeholders, `GREATEST`, the case-insensitive username match, unique-violation errors), with a migrations folder
per dialect (`migrations/sqlite`, `migrations/postgres`; a schema change adds the same number to both). SQLite runs
write transactions one at a time (`_txlock=immediate`); on Postgres every transaction that reads a row and then
changes it locks it first (`SELECT … FOR UPDATE`, the user's row for writes to their content, an advisory lock for
sign-up), and the change feed is read at `REPEATABLE READ`. Timestamps and seqs are `BIGINT`, ciphertext `BYTEA`.
Either way the server is a single instance (the in-memory state below).

`users`, `credentials` (WebAuthn: credential_id BLOB unique, public_key, sign_count, transports, aaguid,
flags, name, created_at, last_used_at, wrapped_mk_prf nullable), `sessions` (id_hash PK, user_id, state,
created_at, expires_at, last_seen_at, auth_at = last credential proof, see §5.1 "Re-authentication", mfa_failures), `entries` (id, user_id, created_at, updated_at, version, header_nonce,
header_ct, body_nonce, body_ct), `blobs` (id, user_id, entry_id nullable, nonce, data BLOB, size, created_at),
`settings` (user_id PK, nonce, ct, updated_at), `recovery_tokens`, `totp_used_steps` or a `last_totp_step` column.
Sync (migration 0003): `users.sync_seq`, `users.tombstone_floor`, a `seq` column on `entries`, `blobs` and `settings`,
and `tombstones` (user_id, kind ∈ entry|blob, item_id, seq, deleted_at).
Lockouts (migration 0007): `users.totp_fail_count`, `users.totp_fail_window_start`, `users.totp_locked_until`,
`sessions.mfa_failures` (§5.1 "Rate limits").
Store images in the database (with SQLite, a single file to back up).
WebAuthn challenges: in memory with 5-min TTL (single instance). At most 10,000 outstanding, and at most 8 per owner
(the client address, IPv6 by /64, for discoverable sign-in; the account for registration and the second step): past
either, the oldest (that owner's, or overall) is dropped, so `begin` is never refused; the dropped challenge's
`finish` gets `challenge_expired`.

## 7. Security headers & misc

- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  font-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://api.open-meteo.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  (fonts are self-hosted via `@fontsource/*`; the only third-party origin is Open-Meteo, for opt-in weather). The
  policy does not depend on configuration: no script or frame from another origin, Stripe's included (§5.6).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(self), camera=(), microphone=()`,
  HSTS when origin is https. Request body limits (1 MB JSON, 15 MB blobs). Graceful shutdown.
- Disabled users: sessions revoked. Logging must never include request bodies.
- Data directory: the server sets umask 077, makes the data directory 0700 (also when it already existed) and
  `journal.db`, `-wal`, `-shm` 0600 on start; `secret.key` is 0600.
- Known, accepted metadata leak (documented in README): server sees usernames, entry count, sizes, and
  server-side created/updated timestamps.

## 8. Frontend

Vite + React 18 + TS, `react-router-dom`, TipTap v2 (`@tiptap/react`, StarterKit, Placeholder, Typography,
Link, BubbleMenu, Highlight, TextAlign) with the custom `encryptedImage` node, `hash-wasm` (argon2id), `@fontsource/newsreader`,
`@fontsource/inter`, `@fontsource/ibm-plex-mono`, plus the writing faces below. Plain CSS with CSS custom properties (no Tailwind).

**The scripts are not minified** (`build.minify: false`; CSS still is, and there are no source maps): what the browser
runs is readable in its developer tools, names and layout intact, so the app can be reviewed as served, and
compared with the source (README "Reading the code that runs").

**Follow `design/*.dc.html` closely** (they are HTML mockups; read them for exact colours, spacing, copy):
`Main` = tokens/components, `SignIn`, `SignUp`, `Setup` (passkey + TOTP + recovery key), `Pending`, `Unlock`,
`Editor` (sidebar list grouped by month, client-side search, bubble menu on selection, drop overlay,
status pill "Encrypted · saved", details line: date · time · location chip with remove · word count),
`Mobile` (≤640px: list and editor as separate views, bottom format bar with photo button), `Admin`, `Appearance`.

Routes: `/signup` (start a journal on this device, then straight to the editor), `/signin` (sign in to a
sync account: on a new device, or again after the session ended), `/unlock`, `/` (editor, newest or new entry),
`/e/:id`, `/timeline`, `/timeline/:year`, `/books`, `/books/:year` (`?page=N` deep-links a page), `/settings/sync`
(sync & backup: turn sync on, finish setup, status, remove from this device; storage durability), `/settings/appearance`,
`/settings/security` (auto-lock, PIN unlock, passphrase, recovery key; passkeys and TOTP for sync accounts), `/admin`, and the
public `/about` (how safety and privacy work) and `/welcome` (the promotional landing page). A visit to `/` from a
browser with no journal that isn't known to be returning shows the landing page; otherwise it goes to `/signin` or
`/signup`. Route guards from the device's journal + lock state; the server session only matters for `/signin` and
`/admin`. A browser still signed in to an account but holding no journal (accounts from before §10) unlocks into one. Timeline, books, about, landing and the year book are lazy chunks; a
failed chunk load (an old tab after a deploy) reloads the page once, and the server 404s missing `/assets/*`.
Further boards: `Timeline`, `Books`, `YearBook`, `design/about-copy.md` and `design/landing-copy.md` (the About and
landing pages' wording, used verbatim).

Editor behaviour: autosave 800ms after typing stops (encrypt header+body and write them to the device; sync pushes
later, §5.2); pill shows Saving… / Encrypted · saved / Not saved (a failed device write, e.g. storage full; retried with
the next edit). A save still running when the editor closes finishes in the background, and locking waits for it.
Images are stored on the device when added; failed ones show "Not saved · N images". The entry list shows the sync
state ("Only on this device", "Synced · 2 min ago", "Offline", "N entries need attention"); entries with a conflict
open on the conflict screen instead of the editor. Journals without sync get a quiet suggestion at the top of the
entry list (the journal is lost with the browser's data; sync lets you write anywhere), dismissible for two weeks
("×") or for good ("Don't show this again", localStorage `wordsafe.syncNudge.<vaultId>`); Settings → Sync & backup
always offers it.
Drag & drop and paste images anywhere on the editor; "Add photo" button on mobile. New entry auto-fills
date/time/tz, and location if enabled (`navigator.geolocation`, then **on-device** reverse geocode against a
lazily-loaded places dataset bundled in `frontend/public/places/` — build it with a script from GeoNames
`cities1000` (CC-BY; credit in Settings); if the dataset is missing, fall back to `location: null` and
show nothing — never send coordinates anywhere, never store raw coordinates).
Weather (opt-in, `details.weather`, off by default) is the one exception: the browser fetches
`https://api.open-meteo.com/v1/forecast?...&current=temperature_2m,weather_code,is_day` directly, with the position
rounded to 0.1° (~11 km), no credentials and no referrer. Our server never sees it; only `{code, day, tempC}` is kept,
in the encrypted header. Any failure (denied, offline) means `weather: null`. Shown as a small icon + one or two words
(and temperature) chip next to the location, removable per entry; credit Open-Meteo (CC BY 4.0) in Settings.

Theming: tokens `--paper --surface --ink --muted --hairline --accent --accent-ink --danger --soft --sel` on `:root`.
Built-in themes: Paper, Paper Dark, Solarized Light, Quiet Light, Nord, Gruvbox Dark (values in
`design/Editor.dc.html` / `design/Appearance.dc.html`). Mode System/Light/Dark (System uses `prefers-color-scheme`,
live). Import: VS Code theme JSON (JSONC: strip comments + trailing commas; map
`editor.background→paper, sideBar.background→surface, editor.foreground→ink, descriptionForeground→muted,
panel.border|editorGroup.border→hairline, button.background|focusBorder→accent, button.foreground→accent-ink,
errorForeground→danger`, derive missing ones; `type` field decides light/dark) and base16 YAML
(`base00 paper, base01 surface, base05 ink, base04 muted, base02 hairline, base0D accent, base08 danger`).
After mapping, enforce contrast (ink & muted ≥ 4.5:1 on paper, accent-ink ≥ 4.5:1 on accent) by adjusting lightness.
Theme choice is applied before first paint from a non-secret localStorage copy of just the token values
(themes are not sensitive; the encrypted settings blob is the source of truth once unlocked).

**Formatting (editor).**
- *Desktop format bar*: a slim `role="toolbar"` above the text, aligned to the 680px writing measure and sticky at the
  top: a paragraph-style picker (Title = h1, Heading = h2, Subheading = h3, Body, Quote, Bulleted list, Numbered list;
  shows the current block's style; a button + listbox), then Bold, Italic, Highlight │ Align left, Align centre │
  Section divider │ Link. It fades out after a typing keystroke in the editor and returns on real mouse movement, a
  pointer press in the text (selection by mouse) or focus inside the bar. Roving tabindex (one Tab stop; Left/Right/Home/End),
  Alt+F10 from the editor focuses it, Escape returns to the text. Buttons are 36px `<button>`s with `aria-pressed`,
  `aria-label`, `aria-keyshortcuts` and a tooltip naming the shortcut with the platform's modifier (⌘ on Apple, Ctrl elsewhere).
- *Bubble menu* on a selection: Bold, Italic, Highlight, Heading, Quote, Link.
- *Mobile bar* (≤640px, 44px targets, scrolls sideways): native style `<select>`, Bold, Italic, Highlight, Align left,
  Align centre, Section divider, Link; Add photo stays pinned at the end.
- *Link prompt*: a small popover by the selection (Mod-K, or any Link button). On a link it edits or removes it;
  with nothing selected it inserts the address as a link. Only `http(s):` and `mailto:` are accepted.
- *Highlight*: one colour per theme, `--highlight` = the accent mixed into paper (20% light, 28% dark themes, reduced until ink
  on it is ≥ 4.5:1), and `--highlight-ink` = ink raised to ≥ 4.5:1 on it; both derived for built-in and imported themes.
- *Alignment*: left/centre on paragraphs and headings only. *Section divider*: `horizontalRule`, drawn as a centred
  "⁂" in `--muted`, no line.
- *Coming back later* (settings `returnDividers`, on by default; Settings → Appearance → Entry details): when the
  entry hasn't changed for 3 hours (since its last save before it was opened, or since the last change while open) and
  the first change is new writing after the end of the existing text (not an edit further up, not a deletion; Enter
  or spaces alone wait for the first real character), a divider with `at` = now goes between the old text and the new;
  words typed straight on from the last line become their own paragraph (leading spaces dropped). Not added to an
  empty entry or one that already ends with a divider; changes taken in from another device don't count. Undo removes
  it with the keystroke. The time sits small and muted to the right of the ⁂ (below it at ≤640px): `HH:MM` on the
  entry's own day, `Thu · 13 Nov · 09:05` on a later one, in the entry's time zone. Hovering (or selecting) the
  divider shows "What's this?", a popover that explains it and offers "Turn off" (sets `returnDividers: false`, toast
  with Undo) and "Remove this one". Year books print the time under the ⁂; Markdown export writes `*HH:MM*` after the `---`.
- *Shortcuts* (Mod = ⌘/Ctrl): Mod-B bold, Mod-I italic, Mod-Shift-H highlight, Mod-K link, Mod-Alt-0 body,
  Mod-Alt-1/2/3 title/heading/subheading (these *set* the style), Mod-Shift-7 numbered list, Mod-Shift-8 bulleted list,
  Mod-Shift-B quote (lists and quote toggle), Mod-Shift-L align left, Mod-Shift-E centre, Mod-Shift-Enter or Mod-Alt-Minus
  section divider, Mod-Z / Mod-Shift-Z (and Mod-Y) undo/redo, Alt-F10 format bar, Mod-/ "Keyboard shortcuts" dialog (also
  in the entry options ⋯ menu). They apply only inside the editor (the app has no global shortcuts). TipTap's
  Mod-Shift-R/J (right/justify) are not bound, so the browser's reload keeps working; keys typed with AltGr on Windows
  (reported as Ctrl+Alt) are left to the browser so e.g. AltGr+0 still types `}`. StarterKit's strike (Mod-Shift-S) and
  inline code (Mod-E) marks keep their default shortcuts but have no buttons.

**Writing typography** (Settings → Appearance → Writing, global): typeface picker (each option is a sample line in its
own face) — Classic serifs: Newsreader (default), EB Garamond, Cormorant Garamond, Libre Caslon Text; Modern serifs:
Literata, Source Serif 4, Fraunces; Sans & mono: Inter, IBM Plex Sans, IBM Plex Mono — Text size Small/Medium/Large/Extra
large = 18/20/21/23px (default Large, the size the editor was designed at; each face carries a small optical
correction, and phones use 0.905×) and Line spacing Compact 1.55 / Comfortable 1.7 (default) / Airy 1.85. Applied as
`--writing-font --writing-size --writing-leading` to the entry title (1.9× size), body, captions and the mobile editor.
Faces are self-hosted from `@fontsource/*` / `@fontsource-variable/*` and each face's CSS is a lazily imported chunk,
loaded only when that face is in use or the picker scrolls into view. All are SIL OFL 1.1 (noted under the picker).

### 8.1 Frontend implementation notes (fixed by the frontend)

- **Places dataset:** `frontend/scripts/build-places.mjs` (`npm run places`) downloads GeoNames `cities1000.zip` +
  `admin1CodesASCII.txt` and writes **one** file, `public/places/places.v1.json` (~5 MB, ~2 MB gzipped), with places
  binned into 1° lat/lon tiles *inside* that file (`tiles["lat,lon"] = [countries[], name, dLat, dLon, popClass, admin1, countryIdx, …]`).
  The client fetches the whole file lazily (only when location is enabled) instead of per-tile files, so request paths
  never reveal the user's area to the server. If the file is missing (or the SPA fallback returns HTML), location is `null`.
  Neighbourhood precision can only name places that exist in `cities1000` (sections with population ≥ 1000).
- **No-flash theming:** `/theme-boot.js` is a classic, render-blocking script in `<head>` (module scripts are deferred and
  could paint first). It reads localStorage `journal.theme.v1` = `{mode, light:{cssVar: value}, dark:{cssVar: value},
  writing:{font, vars:{"writing-font", "writing-size", "writing-leading"}}}` (each writing value is checked against a
  strict pattern before it is set; the face's CSS itself is loaded by the app on start).
  Besides the ten tokens the client derives a few CSS variables from them (`--field --line --notice --danger-soft
  --toolbar --toolbar-ink --ring --drop --accent-text --highlight --highlight-ink`); `--accent-text` is the accent raised to ≥ 4.5:1 on paper and is
  used wherever the accent colours text. Derived values are not stored in the settings blob.
- **Unlock** is local: passphrase unlock unwraps `keys.wrappedMkPass`; passkey unlock runs a client-side `get()` with a
  random challenge, `allowCredentials` = the user's `passkeyWraps`, and the PRF salt (nothing is sent to the server).
  Passkey *sign-in* uses `/api/auth/passkey/begin|finish` with the PRF extension added and unlocks in the same ceremony
  when a wrap exists. PRF outputs are stripped from every credential sent to the server.
- Existing passkeys without a PRF wrap can be upgraded from Settings → Passkeys & 2FA ("Use to unlock"), using
  `credentialId` from `/api/me`.
- Local search covers decrypted headers only (title, snippet, location label). New entries are created on the server
  only once they have a title, text or an image; an entry is saved before its first image upload.
- Settings routes: `/settings/security` (labelled "Passkeys & 2FA"), `/settings/appearance` (with `#entry-details`),
  `/settings/export` (§9). Settings also links "How privacy works" (`/about`).
- **Sign-in second step** (§5.1 "Passphrase sign-in"): `totp_required` shows the code form; with `passkeyAllowed` it also
  offers "Use a passkey instead"; `passkey_required` shows "Continue with your passkey" (`/login/passkey/begin|finish`,
  UV required, no PRF: the passphrase already unlocks). `totp_locked` shows until when codes are paused (`lockedUntil`)
  and points to the passkey (if allowed) or the recovery key; `unauthenticated`/`no_mfa_pending` (expired or 5 wrong
  answers) go back to the passphrase step.
- **Second factor first:** a user with `status == "active" && !hasSecondFactor` is routed to `/signup/secure` (after
  unlocking), which explains why; the client never calls entry, blob, settings or admin endpoints for such a user
  (settings load only once the account may sync: admins need `hasSecondFactor`). Any `403 second_factor_required` re-reads `/api/me` and routes there too.
- **Passkey user verification:** registration (`authenticatorSelection.userVerification`), the PRF follow-up `get()`,
  passkey unlock and both sign-ins all require UV, because a PRF output unlocks the journal.
- **Navigation:** Write · Timeline · Books (in the editor's sidebar head on desktop, a segmented control on the mobile
  list, the slim header of the timeline and books). Timeline and Books appear once decrypted headers show entries on
  at least two different calendar days. The username with an avatar initial (sidebar footer, view headers) opens
  Settings; Admin and Lock stay in the footer; Settings stays in the editor's ⋯ menu.
- **Timeline:** computed in the browser from decrypted headers (days are calendar days in each entry's own `tz`): year,
  totals (entries · words · distinct places · photos), previous/next year, a day strip (one dot per day: written =
  accent, not written = hairline, future = faint; a `role="img"` figure with a text summary, plus month buttons for
  keyboard users; clicking a written day scrolls to it), month sections with sticky labels and totals, entries on a
  spine, and "A quiet stretch: N days" between entries more than 7 days apart. Thumbnails come from `coverBlobId`:
  fetched and decrypted only when the card nears the viewport (IntersectionObserver), centre-cropped to 264×200 in a
  canvas, kept as in-memory object URLs (at most 3 decrypting at once) and revoked when the journal locks.
- **Books / year book:** covers per §4 `books`, edited on `/books` (title + six cloths, a radio group). The year book
  decrypts the year's bodies into memory (gone when the page closes), lays them out with CSS columns (one column = one
  page, measured after fonts load; a two-page spread from 860px wide, one page below), turns pages with the buttons, ←/→,
  PageUp/PageDown, Home/End and horizontal swipes, and deep-links `?page=N`. Page 1 is the title and contents (months,
  dotted leaders, entry counts, measured page numbers); each month starts a page; dividers render as ⁂; images keep
  their proportions before they load and decrypt when visible. "Export this year" runs §9 for 1 January–31 December;
  "Print" decrypts every photo first, then prints with a print stylesheet (book margins, page numbers in `@page`
  margin boxes where supported, a page per entry, no app chrome).
- **Passphrase policy** (security review M3): a zxcvbn-style estimate in `src/lib/strength.ts`. Each run of letters,
  digits or symbols is matched against common passwords, English words and names (compact lists derived from zxcvbn
  4.4.2's MIT-licensed frequency lists, a lazily loaded ~150 KB chunk fetched only by the passphrase fields), years,
  dates, repeats, sequences and l33t substitutions; other characters are priced as brute force, plus a little for the
  arrangement. A passphrase that is itself a known password is capped low; one containing the username is refused.
  Accepted at ≥ 60 bits (about four uncommon random words, or 16+ random mixed characters), so `Summer2024!!` and
  `Liverpool2023` are refused, with feedback saying why. Before the lists load a small built-in list is used; the
  submit handlers wait for the lists.
- **Writing privacy:** the entry title, body (desktop and mobile) and image captions set `spellcheck="false"`,
  `autocorrect="off"`, `autocomplete="off"` and the opt-outs `data-gramm="false"`, `data-gramm_editor="false"`,
  `data-enable-grammarly="false"`, `data-lt-active="false"`, `data-ms-editor="false"` (`autocapitalize="sentences"` stays;
  it is local).
- **Extension detector** (`src/security/extensions.ts`): runs only while the app is open and reports nothing to the
  server. A MutationObserver on `document.documentElement` (subtree, attributes, childList, plus an initial scan) flags
  nodes and attributes the app didn't create: known extension elements and attribute prefixes (Grammarly, LanguageTool,
  1Password, LastPass, Bitwarden, Dashlane, Dark Reader, Microsoft Editor) and any `src`/`href`/style URL with a
  `chrome-extension:`, `moz-extension:`, `safari-web-extension:` or `ms-browser-extension:` scheme; plus
  `securitypolicyviolation` events from those schemes. The app's own nodes (ProseMirror, Tippy, node views, its opt-out
  attributes with their own values, dialogs, portals) are allowlisted and unit-tested. The editor then shows a calm,
  dismissible notice with "How to" (private window, separate profile, per-site extension access) and "Don't show again
  on this device" (localStorage `journal.extensionNotice.dismissed`, non-secret).

## 9. Export as Markdown (client-side only)

The server cannot decrypt, so export is done entirely in the browser while unlocked. Nothing new on the server.

- **Where:** Settings → Export (`/settings/export`), plus "Export as Markdown" in the editor's entry options (⋯) menu for a single entry.
- **Options:** all entries or a date range; include images (default on); format = one `.md` file per entry (default)
  or a single combined `journal.md`.
- **Output:** a `.zip` built in the browser (`fflate`), downloaded via an object URL that is revoked afterwards:
  ```
  journal-export-2026-11-11/
    2026/2026-11-11-a-long-walk-after-the-rain.md
    images/<blobId>.jpg
  ```
  The per-entry filename is `YYYY-MM-DD-<slug>.md`; on a collision append `-2`, `-3`. Untitled entries use `untitled`.
- **Each file:** YAML front matter, then the body:
  ```markdown
  ---
  title: "A long walk after the rain"
  date: 2026-11-11T21:40:00+00:00
  timezone: Europe/London
  location: "Clifton, Bristol"   # omitted when null
  words: 412
  ---

  The river was higher than I expected…

  ![The footbridge, just before dark.](../images/<blobId>.jpg)
  *The footbridge, just before dark.*
  ```
- **TipTap JSON → Markdown converter** (`src/export/markdown.ts`, unit-tested): paragraphs, headings (Title `#`,
  Heading `##`, Subheading `###`), bold, italic, highlight (`==text==`, the common extended-Markdown form), links,
  blockquotes, bullet/ordered lists (nested), hard breaks, section dividers (`---`, always with a blank line before
  and after, also inside list items, so the line above never becomes a setext heading), code, and `encryptedImage`
  (an image link plus an italic caption line). Escape Markdown-special characters in text (including runs of `==`).
  **Alignment is dropped:** a centred paragraph or heading is written exactly like a left-aligned one, because
  Markdown has no portable way to express alignment (and raw HTML would not survive many Markdown tools).
- **Combined file:** each entry is `## <title>` and an italic line (date time · place · words); the title and place are
  escaped like body text (Markdown, HTML, entity-like `&…;`, leading/trailing `#`), so they can't inject markup.
- **Year book:** "Export this year" on `/books/:year` is the per-entry export limited to that calendar year.
- **UX:** progress ("Decrypting 37 of 120…"). Before the download, a calm notice says the exported files are **not
  encrypted** and to store them carefully. Failed entries or images are skipped and listed at the end, never silently dropped.

## 10. Offline-first: the journal on the device

- **Storage.** IndexedDB database `wordsafe` (stores `vaults`, `entries`, `blobs`, `settings`, `outbox`, `meta`) holds the
  journal in the same encrypted shapes the server uses, plus: the vault record (KDF params, wrapped MKs, passkey wraps,
  the sync account if any, the sync cursor, last export time), per entry its server version, `base` copy, `dirty`
  flag, local revision, `incoming` copy and `conflict`, per image whether it is on the server, and an outbox of
  deletions to send. One journal per browser; signing in to a different account requires removing it first.
  Signing in (`/signin`, linked from the "No password yet" banner and Settings → Sync) replaces a journal that is
  only on this device: the page says so, and when it holds entries asks for a yes (and points to Export) first.
- **Starting a journal** ("Start writing", `/signup`) needs no server and asks nothing: an MK is generated and sealed
  (AES-256-GCM, AAD `vault:<vaultId>:device`) under a fresh *non-extractable* AES "device key" kept in IndexedDB `meta`
  (`device:<vaultId>`); the vault's `wrappedMkPass` is null and there is no recovery key yet. Such a journal opens by
  itself on this device, has no auto-lock, PIN or lock button, and the editor shows a banner: "No password yet" →
  **Set a password**: passphrase → KDF params, passphrase wrap, recovery key and wrap made exactly as in §3; the vault is
  updated and the device key deleted in one transaction; the recovery key is shown once, then the choice of
  **Save locally** (keep it on this device) or **Set up sync** (→ Settings → Sync). Turning sync on needs a password. The
  recovery key's server credential is kept sealed with the content key so that turning sync on later doesn't need the
  recovery key.
- **Unlocking, passphrase changes, recovery** of a journal without sync are local. For a synced journal they go
  through the server (§5) and the device copy of the keys follows `/api/me`; unlocking still works offline with the
  keys last seen (a passphrase changed on another device works here after the next online refresh).
- **Turning sync on** creates the account from the device's own KDF params, `authKey` (from the passphrase, entered
  again), wrapped MKs and recovery credential: nothing is re-encrypted, and everything uploads with the first sync straight away
  (for an admin, once it has a second factor). The journal keeps working throughout.
- **Removing from a device** (synced: signs out and deletes the local copy, warning about unpushed changes) and
  **deleting a journal without sync** (type "delete" to confirm) are in Settings → Sync & backup.
- **Durability.** The app asks for persistent storage (`navigator.storage.persist()`) when a journal is created or set up
  on a device; Settings shows whether the browser granted it, the space used, and for journals without sync the last
  full export (a full export records it).
- **Offline app.** A service worker (`/sw.js`, generated at build time from `src/sw/sw-template.js`) precaches the app
  shell (index.html, every built JS/CSS file, Latin font subsets; other font subsets and the places dataset are cached
  on first use) and serves navigations from it. `/api/` never goes through its cache. A new version installs in the
  background; the page offers "Update" and only then switches (after saving open entries; the journal reopens after
  the reload like any other). The worker is
  only registered in production builds.

## 11. Desktop app (`desktop/`)

The frontend runs unchanged in the system's web view (WKWebView, WebView2, WebKitGTK) inside a Tauri app
(`desktop/src-tauri`). `window.kagimoDesktop` (set by `desktop/src-tauri/src/bridge.js`, typed in
`frontend/src/desktop/bridge.ts`) is how it knows, and all it can reach of the computer: each call is a Tauri command
in `src/lib.rs` that checks its arguments, and the window's capability (`capabilities/main.json`) allows those
commands and no others (no plugin or core APIs).

- **Pages.** Built into the app from `desktop/renderer` and served by Tauri at `tauri://localhost` (macOS, Linux) or
  `http://tauri.localhost` (Windows), with the CSP of §7 minus the weather service (plus Tauri's IPC). Navigation
  away is blocked and links meant elsewhere, or for a new window, open in the browser. No service worker; no reload
  copy of the keys (§3): a journal with a password asks for it at every start.
- **Storage.** `frontend/src/local/repo.ts` picks `folderRepo.ts` in place of `idbRepo.ts`: the records of §10, one
  file each, in the folder the person chose (kept in the app's `config.json`): `kagimo.json`
  (`{format: "kagimo-journal", version: 1, vault}`), `settings.json`, `outbox.json`, `entries/<id>.json`,
  `blobs/<id>.json` + `blobs/<id>.bin`. Ids are lowercase UUIDs and are the only thing that becomes part of a file
  name. A write goes to a temporary file that is renamed over the target. Operations run one at a time; one that
  touches several files writes them in the order that is safe to stop halfway (a burned entry's deletion is queued
  before its file goes). A folder holds one journal: reads for any other vault id return nothing and writes are
  refused, and signing in over a local journal deletes it before the account's is set up. Only a folder picked in the
  system dialog can be opened. The app holds a single-instance lock.
- **A journal without a password.** Its MK goes to the app, which keeps it in the OS credential store (service
  `com.kagimo.desktop`, account = vault id): Keychain, Windows Credential Manager, or the Secret Service on Linux;
  where there is none, a journal without a password can't be kept. Setting a password deletes it.
- **Starting.** No folder chosen: a page asking for one. A folder without a journal: "Start writing" (as §10) or
  "Sign in to a sync account". A folder that can't be reached, or whose `kagimo.json` isn't a journal or is from a
  newer format version, says so and offers another folder.
- **Sync.** The page's `/api/*` requests (`frontend/src/api/client.ts`) go through the bridge's `api` to the app,
  which sends them to the sync server (default `https://kagimo.com`; any `https://` origin, or `http://` on localhost,
  can be set from the sign-in and turn-on-sync forms, which signs out of the previous one) with `Origin` set to that
  server, no redirects followed, and the server's cookies in the app's own jar: the page never sees them. The jar is
  kept between runs in the credential store (account `sync-session`); only cookies with an expiry are kept. Until the journal has a sync account or one of those two forms
  is opened, the app makes no API request. WebAuthn is reported as unsupported, so passkey sign-in, passkey unlock
  and adding passkeys are not offered. Stripe pages open in the browser.
- **Closing the window** waits (up to 6 s) for open entries to be saved and, briefly, for waiting changes to be pushed.
- **Not offered:** location and weather (no geolocation), the browser-extension notice, the update banner.
