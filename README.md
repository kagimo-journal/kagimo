# Kagimo

An end-to-end encrypted journal, live at [kagimo.com](https://kagimo.com). It is open
source (AGPL-3.0), and the same server runs self-hosted (see "Running it yourself").

Kagimo is **offline-first**. The journal lives in the browser (IndexedDB, encrypted), opens
without a network and needs no account. Turning on **sync** is optional, and a paid feature
after a free trial. Sync mirrors the journal to the server so it follows you to other
devices. Entries are encrypted in the browser before anything is sent. The server (a single
Go binary with an SQLite file, or Postgres if you prefer) stores ciphertext it can't read.

There is also a **desktop app** (see "Desktop app" below): the same journal, kept as
encrypted files in a folder you choose instead of in a browser. Sync is optional there too.

The client-side crypto (`frontend/src/crypto`) is also published on its own, under the MIT
licence, at [github.com/kagimo-journal/crypto](https://github.com/kagimo-journal/crypto), so
it can be audited and reused without the rest. See "Licence" at the end, and "Publishing the
crypto code" for how that copy is kept in step.

- Rich-text entries (text only: photos can't be added, though ones added before that change
  still show), a month-by-month list and local search
- Works offline (service worker + IndexedDB); edits made on two devices at once merge
  paragraph by paragraph, and only clashing passages ask you to choose
- Sign in with a passkey, or with a passphrase plus a second factor (an authenticator
  app code or a passkey)
- A recovery key in case you forget your passphrase
- Optional location ("Clifton, Bristol"), worked out on your device from a bundled
  GeoNames dataset. Coordinates never leave the device.
- Themes, including VS Code and base16 imports; Markdown export
- An admin page for managing the people who turn on sync

The full contract (API, cryptography, database) is in [SPEC.md](SPEC.md).

## Threat model, in plain words

A journal without sync never reaches the server at all. For journals with sync on:

**What the server, and anyone who runs it or copies its database, cannot see:**
entry titles, text, the date and time *you* gave the entry, locations, word counts,
photos and captions, your settings and themes, your passphrase, your recovery key and
your master key. All of these are encrypted in your browser with keys derived from your
passphrase (Argon2id, then AES-256-GCM). The server only receives a derived login key,
which it stores as a further Argon2id hash. `e2e/` checks this on every run by scanning
the raw SQLite files for the plaintext it wrote.

**What the server can see (metadata):**

- usernames, whether you are an admin, and your account status
- when accounts were created and last active
- how many entries you have, and the server's own "created/updated" time for each one
- the size of every entry and photo, and which entry a photo belongs to
- how many passkeys you have, their names, and whether TOTP is turned on
- your IP address while you're connected (used in memory for rate limiting), and request
  paths, which include entry IDs, in the server log (never request bodies or query strings)

**What the admin can do:** disable, re-enable and delete accounts. An
admin cannot read anyone's journal, including through the database or the admin CLI, and
cannot reset anyone's passphrase.

**Things to understand:**

- **Forgetting your passphrase *and* losing your recovery key means losing your
  journal.** No one can decrypt it, including the admin. A passkey that can unlock the
  journal is a convenience on the devices where it's set up; it does not replace the
  recovery key. Write the recovery key down and keep it somewhere safe.
- **You trust the server to deliver honest code.** Like every encrypted web app, the
  JavaScript that does the encryption comes from the server each time. Someone who
  controls the server could ship altered code that captures your passphrase the next
  time you unlock. Run it on a machine you control.
- **Your browser must trust the TLS certificate.** Passkeys and WebCrypto only work in a
  secure context. Clicking through a certificate warning is unsafe and doesn't work
  anyway. On kagimo.local this means installing Caddy's local root CA on each device
  (see below).
- **A weak passphrase can be guessed offline** by someone who has a copy of the
  database. The key derivation is deliberately slow (64 MiB Argon2id), but a long
  passphrase of four or more random words is what really protects you.
- **While the journal is unlocked**, decrypted entries live in that browser tab's memory.
  The journal locks after 5 minutes idle (adjustable) and when the tab is closed. A reload
  keeps it open (within the idle limit), using a key the page can use but not read out; a
  closed tab that is reopened or restored asks for the passphrase. While it is unlocked that
  key and the copy it protects are in the browser profile on disk, so lock the journal
  before leaving a shared computer.
- **A journal without a password** (how "Start writing" begins) is encrypted, but opens for
  anyone using that browser profile. Set a password from the banner to lock it.
- **PIN unlock is a convenience, not a second passphrase.** If you turn it on, a locked tab
  reopens with a 6–8 digit PIN until it has been inactive for the time you choose (15 min
  to 1 day), after 5 wrong PINs, or until the tab closes; then the passphrase is needed.
  The PIN-wrapped key is stored only inside your encrypted settings and, while locked, in
  that tab's memory, so someone who could read the tab's memory could brute-force the PIN.
  **Markdown exports are not encrypted.**
- **A second factor is optional, except for admins.** Once you have set up an
  authenticator app or a passkey, signing in with a passphrase always asks for it as
  well. An account without one signs in with the passphrase alone, and may remove its
  last one. An admin account (this includes the first account) must have one: until it
  does it can sign in, but only to finish setting up, and it can't remove its last.
- **Wrong-passphrase limits.** After 30 wrong passphrases in an hour, an account stops
  accepting passphrase sign-ins from browsers it doesn't know. Browsers you have signed
  in on before are remembered (a signed cookie) and keep their own, separate allowance,
  so a stranger guessing at your username can't lock you out of your own devices.
  After 10 wrong authenticator codes in a day, codes are refused for an hour (after 20,
  for a day); a passkey or your recovery key still works. That count is stored in the
  database, so restarting the server doesn't reset it.

## Residual risks

Some risks can't be fixed in code. They are listed here so you can decide whether they
matter to you.

- **The server delivers the app.** The JavaScript that encrypts your journal comes from
  this server every time you open it, so whoever controls the server could ship altered
  code that captures your passphrase. Run it on a machine you control.
- **The server can hide or undo things.** It can't read or forge your entries, settings
  or photos, and it can't move them between entries or people. But it can withhold or
  delete them, roll one back to an older version, or pair an entry's old title/summary
  with a newer body of the same entry.
- **Weak passphrases can be guessed offline** by anyone with a copy of the database.
  Your master key is never replaced: someone who once had your wrapped key and the
  passphrase (or recovery key) that opens it keeps that ability even after you change
  the passphrase.
- **The recovery key on its own opens an account without an authenticator app.** That is
  by design (it is 160 random bits), but store it as carefully as the passphrase.
- **Locking the journal doesn't sign you out.** The sign-in cookie lasts 30 days with no
  idle timeout. Someone who gets hold of it in that time can delete entries or see the
  metadata below, but can't read anything.
- **Metadata is visible to the server:** usernames, notes, how many entries and photos
  you have and their sizes, timestamps, which photo belongs to which entry, IP addresses
  and IDs.
- **Trusting Caddy's local CA is broad.** A device that trusts it trusts it for every
  domain, so keep the CA key on the server safe.
- **While unlocked, the text is in the browser.** Browser extensions, the clipboard,
  printing and exports are outside the app's control.
- **The first account on a fresh instance becomes the admin**, so create it straight
  after installing.
- **Most rate limits are kept in memory** and start again when the server restarts: the
  per-address limits and the wrong-passphrase allowances. The authenticator-code lockout
  and the five tries each sign-in attempt gets at its second step are stored in the
  database and survive a restart.
- **Signing up reveals whether a username is taken.** Sign-in and recovery answer the
  same for accounts that exist and ones that don't, but creating an account has to say
  when the name is in use (`409 username_taken`), so anyone can test whether a given
  username has an account here. Pick a username that isn't your name if that matters.

## Running it yourself

The server is one binary (`make build` → `bin/journal`) with the web app embedded. It needs
a data directory, the public origin people will open it at, and HTTPS in front of it
(passkeys and WebCrypto only work in a secure context; `http://localhost` is the one
exception). There are two ready-made ways to run it: as a container, or as a systemd
service behind Caddy (the next section).

### As a container

```sh
make places          # optional: the place-name dataset, copied into the image if present
docker build -t kagimo .
docker run -d --name kagimo -p 127.0.0.1:8080:8080 -v kagimo-data:/data \
  -e JOURNAL_ORIGIN=https://journal.example.com kagimo
```

Each push to `main` that passes the tests also publishes this image as
`ghcr.io/kagimo-journal/kagimo` (`:latest`, and `:<commit>`).

The image listens on port 8080, runs as an unprivileged `journal` user and keeps
everything in the volume at `/data`. Put a reverse proxy that terminates TLS in front of
it. If that proxy is not on the same machine, tell the server which header carries the
client's address with `JOURNAL_CLIENT_IP_HEADER` (rate limits are per address); only name a
header the proxy always overwrites. Admin commands run in the container:
`docker exec kagimo entrypoint admin list`.

Run exactly one instance, whichever database you use: WebAuthn challenges and most rate
limits are kept in memory.

### Database: SQLite or Postgres

By default everything is in one SQLite file, `journal.db` in the data directory. Nothing
needs setting up.

To use Postgres instead, create an empty database and give the server its URL in the
environment (not a flag: it carries the password):

```sh
createdb journal
JOURNAL_DATABASE_URL='postgres://journal:secret@db.example.com:5432/journal?sslmode=require' \
  bin/journal -origin https://journal.example.com
```

The server creates its tables on first start. `journal admin` reads the same variable. The
data directory is still needed for `secret.key`. There is no tool to move an existing
journal between the two; choose before people start syncing.

## Running it on a home network

This is the systemd-and-Caddy setup, for a Linux machine on a home network. The files assume
it is called `kagimo.local`; put your own host name in `deploy/Caddyfile` and
`deploy/journal.service`.

Prerequisites on that machine: Go 1.27, Node 22 + npm, sqlite3, Caddy (running as the system
service, with `import /etc/caddy/conf.d/*` in `/etc/caddy/Caddyfile`), and avahi for mDNS.

```sh
deploy/install-selfhost.sh                      # build, then print the root steps
deploy/install-selfhost.sh --from <old-data>    # …plus steps to migrate an existing data dir
```

The script builds everything as your user (npm dependencies, the GeoNames places dataset
if it's missing, the frontend into `backend/web/dist`, and `bin/journal` with the web app
embedded). It never runs `sudo`. It prints the root steps for you to run:

1. create a dedicated system user `journal` (no shell, no home);
2. install the binary as `/usr/local/bin/journal` and `deploy/journal.service` as the
   **system** unit `/etc/systemd/system/journal.service`. The unit runs as `journal`,
   keeps its data in `/var/lib/journal` (`StateDirectory`, mode 0700), and is sandboxed:
   read-only file system apart from that directory (`ProtectSystem=strict`), no access to
   `/home`, a private `/tmp`, no capabilities, `NoNewPrivileges`, loopback-only networking,
   and a `@system-service` system-call filter. `systemd-analyze security journal.service`
   rates it about 1.0 ("OK");
3. with `--from DIR`: stop the old server, then copy `journal.db` (via `sqlite3 .backup`)
   and `secret.key` from `DIR` into `/var/lib/journal`, owned by `journal`, mode 0600;
4. `systemctl enable --now journal`; it listens on `127.0.0.1:8080` with
   `-origin https://kagimo.local -rp-id kagimo.local`;
5. install `deploy/Caddyfile` as `/etc/caddy/conf.d/journal.caddy` and reload Caddy
   (`tls internal`, gzip/zstd, 16 MiB request bodies, proxy to `127.0.0.1:8080`);
6. copy Caddy's root CA (`/var/lib/caddy/pki/authorities/local/root.crt`) and trust it
   on every device that will use the journal (Linux, macOS, iOS, Android and Windows
   instructions are printed).

Then open <https://kagimo.local>, start a journal and turn on sync in Settings → Sync &
backup. **The first sync account on an empty database becomes the admin.** It has to add a
passkey or an authenticator app before it syncs or can open the admin page. Anyone can
create a sync account after that; it syncs straight away, and a second factor is optional.

Logs: `journalctl -u journal -f`. To update after pulling changes, run
`deploy/install-selfhost.sh` again, repeat the "install the binary" step and
`sudo systemctl restart journal`.

Configuration flags (each has an environment variable):

| flag | env | default |
|---|---|---|
| `-addr` | `JOURNAL_ADDR` | `127.0.0.1:8080` |
| `-data` | `JOURNAL_DATA` | `./data` (`journal.db`, `secret.key`) |
| `-origin` | `JOURNAL_ORIGIN` | `http://localhost:8080` |
| `-rp-id` | `JOURNAL_RP_ID` | host part of the origin |
| `-rp-name` | `JOURNAL_RP_NAME` | `Kagimo` (also the TOTP issuer) |
| `-client-ip-header` | `JOURNAL_CLIENT_IP_HEADER` | unset (trusted proxy header with the client IP) |
| `-metrics-addr` | `JOURNAL_METRICS_ADDR` | unset = off (see "Metrics") |
| — | `JOURNAL_DATABASE_URL` | unset = SQLite; a `postgres://` URL = Postgres |

The rest (desktop downloads, billing, storage limits) are in [SPEC.md](SPEC.md) §1.

## Admin CLI

The CLI works directly on the database, including while the server is running, which
is handy for locking someone out or recovering admin access. On the server, run it as the
service user:

```sh
J="sudo -u journal /usr/local/bin/journal admin -data /var/lib/journal"
$J list
$J promote alice          # make alice an admin
$J disable alice          # disable and sign out everywhere
```

Text that people typed (usernames, notes) is printed with control
characters replaced, so a note can't send escape sequences to your terminal.

The web admin page (`/admin`) can also re-enable and delete accounts, and give free paid access.

## Backups

Everything is in `/var/lib/journal` (or the `-data` directory). Back up **both** files:

- `journal.db`: all accounts, encrypted entries and encrypted photos;
- `secret.key`: the server key that encrypts TOTP secrets at rest (and signs the
  "known browser" cookies). Without it, nobody with TOTP enabled can sign in with their
  passphrase.

Take a consistent copy while the server is running using SQLite's online backup (don't
just `cp` a live WAL database). Keep the copies private: `umask 077` makes every file
created by the commands below readable by you only, and `mkdir -m 700` does the same for
the directory:

```sh
(
  umask 077
  mkdir -m 700 -p ~/journal-backups
  b=~/journal-backups/journal-$(date +%F).db
  sudo sqlite3 /var/lib/journal/journal.db ".backup '$b'"
  sudo install -o "$USER" -m 0600 /var/lib/journal/secret.key ~/journal-backups/secret.key
  sudo chown "$USER" "$b" && chmod 0600 "$b"
)
```

For a data directory you own (e.g. `make run`), the same without `sudo`:

```sh
( umask 077; mkdir -m 700 -p ~/journal-backups
  sqlite3 .local/run-data/journal.db ".backup '$HOME/journal-backups/journal-$(date +%F).db'"
  cp .local/run-data/secret.key ~/journal-backups/ )
```

To restore: `sudo systemctl stop journal`, copy the backup to
`/var/lib/journal/journal.db` (remove any `journal.db-wal`/`-shm` next to it) and
`secret.key` into `/var/lib/journal/`, `sudo chown journal:journal` and `chmod 0600` both,
then `sudo systemctl start journal`.

With Postgres, back the database up with `pg_dump` (or however you back up that server)
instead of `journal.db`; `secret.key` still comes from the data directory.

A backup contains only ciphertext plus the metadata listed above, but treat it as
sensitive anyway: someone with a backup can try to guess weak passphrases offline.

## Development

```sh
make deps     # npm ci for frontend/ and e2e/
make dev      # Go server on 127.0.0.1:8081 + Vite on http://localhost:5173 (hot reload)
make build    # frontend -> backend/web/dist, then bin/journal (web app embedded)
make run      # serve the production build on http://localhost:8090
make test     # gofmt + go vet + go test, frontend typecheck + vitest, desktop typecheck + vitest, API e2e
make smoke    # headless Chromium loads /signin, /signup, /welcome and /about, fails on CSP violations or console errors
make places   # (re)build frontend/public/places/places.v1.json from GeoNames
```

The Go tests use SQLite. To run them against Postgres as well, point them at an empty
database (each test makes and drops a schema of its own in it):

```sh
JOURNAL_TEST_DATABASE_URL='postgres://postgres@localhost:5432/journal_test?sslmode=disable' make test-postgres
```

`dev` and `run` keep their data in `.local/` and use their own ports, so they never
touch the deployed instance in `/var/lib/journal` on port 8080. Use `http://localhost` (not
`127.0.0.1`) in the browser: passkeys need the origin to match.

Layout:

```
backend/    Go server + admin CLI (module `journal`); web/ embeds the built frontend
frontend/   Vite + React + TypeScript; src/crypto holds all of the client-side crypto
            (published as kagimo-journal/crypto, see below)
e2e/        Node 22 end-to-end tests: api.e2e.ts (real client crypto against a fresh
            server on 127.0.0.1:18181, then a raw-database plaintext scan) and smoke.e2e.ts
deploy/     Caddyfile, hardened systemd system unit, install-selfhost.sh, the container
            entrypoint, publish-crypto.sh
design/     design mockups (reference only)
```

The e2e test runs the real browser crypto modules (`frontend/src/crypto`) under Node with
`tsx`. It starts `bin/journal` itself with a throwaway data directory in `e2e/.tmp/`, so
run `make build` first (`make test` does). The smoke test uses `playwright-core` with a
system Chromium (`/usr/bin/chromium`, or set `CHROME=/path/to/chrome`) and never
downloads a browser.

`backend/web/dist/` is build output. Only `.gitkeep` is committed, so a fresh checkout
still compiles; such a binary serves a "web app not built" page
(`backend/web/placeholder.html`).

### Reading the code that runs

The production build does not minify its scripts (`build.minify: false` in `frontend/vite.config.ts`), so the
JavaScript the browser runs keeps its names and layout and can be read in the developer tools (Sources), or
fetched from `/assets/`. This costs about 30% more bytes after compression (roughly 490 kB against 380 kB for
all scripts, gzipped). Review is invited from the About page; reports go to the support address. So what a
browser is served can be compared with this source.

Two pages under Settings → Sync & backup let anyone check the threat model above against their own account:
"What the server sees" sets the most recent entry, as the device has it, beside what the server stores for it,
and "What this device sent" lists every request the tab has made, with its contents. See SPEC §5.7.

### Publishing the crypto code

`frontend/src/crypto` is mirrored, unchanged, to the public repository
[kagimo-journal/crypto](https://github.com/kagimo-journal/crypto) (MIT). That repository also
holds `DESIGN.md` (adapted from SPEC §3 and §10) and `THREAT-MODEL.md` (adapted from the
sections above). Both are written by hand. Keep a local checkout of it next to this
repository at `../kagimo-crypto`.

After a change to the crypto module, commit it here, then:

```sh
make publish-crypto                    # copy, typecheck + test there, commit; never pushes
git -C ../kagimo-crypto show --stat    # review
git -C ../kagimo-crypto push
```

The script refuses to run if:

- the crypto module has uncommitted changes
- the module imports anything outside itself other than `hash-wasm` (tests may also import
  `vitest`)
- the `hash-wasm` versions differ between the two repositories.

Each public commit records this repository's commit as a `Source-Commit:` trailer. If
`SPEC.md` or this README changed since the last sync, the script reminds you to update the
public docs.

So **keep the module self-contained**, and never put anything there you wouldn't publish.
Key storage that needs IndexedDB belongs outside it (`local/resume.ts`, `local/vault.ts`).

## Desktop app

`desktop/` is a [Tauri](https://tauri.app) app: a small Rust program (`desktop/src-tauri`) that
runs the same frontend in the system's own web view (WKWebView on macOS, WebView2 on Windows,
WebKitGTK on Linux), so there is no bundled browser. Two things differ from the website:

- **The journal is kept in a folder you choose**, not in a browser's storage. The first run
  asks for one: an empty folder starts a new journal, a folder that already holds a journal
  opens it. Settings → Sync & backup → Journal folder shows where it is and opens another
  (also File → Open Journal Folder…). One folder holds one journal.
- **There is no web server behind it.** The page's files ship with the app. Until you set up
  sync it talks to no server at all; with sync it talks to kagimo.com, or to a server of
  your own (the sign-in and "turn on sync" forms have a "Sync server" line to change it).

It needs Rust, at the version in `mise.toml` (`mise install`), and on Linux the WebKitGTK
development packages (`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libxdo-dev`).

```sh
make desktop           # frontend -> desktop/renderer, then a debug build of the app
make desktop-run       # build and open it
make desktop-smoke     # drives the real app through its window: folder, password, sync (Linux: under xvfb-run)
make desktop-dist      # release build for this platform (dmg / NSIS installer / AppImage + deb)
make desktop-dist-mac  # macOS: a universal dmg, signed (Developer ID) and notarised, into desktop/release
```

`make test` includes the app's Rust checks (`cargo fmt --check`, `clippy -D warnings`,
`cargo test`). The end-to-end test can't use Playwright, which can't drive the system web
views: a debug build started with `KAGIMO_E2E=1` takes requests on stdin and runs them in its
page (`desktop/src-tauri/src/e2e.rs`, driven by `e2e/src/lib/tauri.ts`). Release builds leave
it out.

**Signing and notarising (macOS).** `desktop/scripts/dist-mac.sh` signs with the Developer ID
Application certificate of Rare Substance PTY LTD (team S3FQ296564; `SIGNING_IDENTITY=` for
another) and notarises with the notarytool keychain profile `kagimo` (`NOTARY_PROFILE=` for
another), made once with `xcrun notarytool store-credentials kagimo --apple-id <id> --team-id S3FQ296564`.
The app runs with the hardened runtime and no exceptions: the web view's JavaScript runs in
WebKit's own process, so the app itself needs no JIT entitlement.

**Offering it for download.** Start the server with `-downloads <folder>` (or
`JOURNAL_DOWNLOADS`) and the front page gets a "Download for …" button for the visitor's
system, for whichever installers (`.AppImage`, `.dmg`, `.exe`) are in that folder. Someone
who already has a journal in the browser never sees the front page (`/` opens the journal), so
the same downloads are in Settings → Desktop app (shown only when there are some). `make run`
and `make dev` point it at `desktop/release`, so after `make desktop-dist-mac` the local front
page offers what was just built.

kagimo.com instead links to GitHub: `JOURNAL_DOWNLOADS_REPO=kagimo-journal/kagimo-releases`
makes the server offer the installers of that public repo's latest release, so the
files never pass through the server. To publish a version, build it and attach it to a
new release; the front page picks it up within 10 minutes, with no deploy:

```sh
make desktop-dist-mac
gh release create v0.1.0 --repo kagimo-journal/kagimo-releases --title "Kagimo 0.1.0" \
  desktop/release/Kagimo-0.1.0-universal.dmg
```

**What's in the folder.** Only ciphertext, in the same shapes the server stores:

```
kagimo.json          the journal: its id and its wrapped (encrypted) keys
settings.json        encrypted settings
outbox.json          deletions still to be sent to the sync server (only with sync)
entries/<id>.json    one entry: encrypted header and body, plus sync bookkeeping
blobs/<id>.json|bin  photos from older synced journals
```

Backing up the folder backs up the journal. Burning an entry deletes its file. Things to
understand:

- **A journal without a password opens only on the computer it was made on.** Its key is
  kept in the operating system's credential store (macOS Keychain, Windows Credential
  Manager, the Secret Service on Linux), never in the folder. A Linux desktop without a
  Secret Service (GNOME Keyring, KWallet) can't keep one: set a password there. Set a password
  before moving the folder or relying on a copy of it: from then on the folder is all you
  need, with the passphrase or the recovery key.
- **One copy of the app at a time.** Don't open the same folder from two computers at once
  through a shared or cloud-synced folder: each would overwrite the other's files. To use a
  journal on several devices, turn on sync and give each device its own folder.
- **Changes made to the files while the app is open aren't noticed** until it restarts.
- **Passkeys don't work in the desktop app** (a passkey belongs to the website's address).
  Sign in with your passphrase, plus an authenticator code if you set one up. An account
  whose only second factor is a passkey can't sign in here.
- **No place names or weather** on new entries: the app can't tell where the computer is.
- Spell-checking is the system's own. Without sync the app makes no network request.

The page has no access to the computer beyond a small set of commands
(`desktop/src-tauri/src/lib.rs`, reached through `window.kagimoDesktop` from
`desktop/src-tauri/src/bridge.js`; `capabilities/main.json` allows those and nothing else):
read or write a journal file by id, ask for a folder, keep or fetch the key above, send an
`/api` request to the sync server. The server's cookies stay in the app (kept between runs in
the credential store); the page never sees them.

## Metrics

With `-metrics-addr` (or `JOURNAL_METRICS_ADDR`, e.g. `127.0.0.1:9091`) the server publishes
Prometheus metrics at `/metrics` on that address, which is separate from the public port so
it can stay private. Labels hold route patterns and status classes only, never paths or ids.

| Metric | What it tells you |
| --- | --- |
| `journal_http_requests_total{route,code}` | requests by route pattern (`GET /api/sync`, `PUT /api/entries/{id}`, `static`…) and `2xx`/`4xx`/… |
| `journal_http_request_duration_seconds{route}` | latency histogram |
| `journal_http_response_bytes_total{route}` | bytes sent |
| `journal_sync_pulls_total{result}` | change-feed pages: `empty` (nothing new), `changes`, `full` (since=0) |
| `journal_sync_items_total{kind}` | entries / deletions / settings sent down in the feed |
| `journal_active_users{window}` | distinct signed-in users seen in the last `5m` / `1h` / `24h` |

Useful queries:

```promql
# requests per minute, by route
sum by (route) (rate(journal_http_requests_total[5m])) * 60

# chattiness: API requests per active user per minute
sum(rate(journal_http_requests_total{route!="static"}[15m])) * 60
  / clamp_min(max(journal_active_users{window="5m"}), 1)

# share of sync pulls that found nothing (idle polling)
sum(rate(journal_sync_pulls_total{result="empty"}[1h]))
  / sum(rate(journal_sync_pulls_total[1h]))

# p95 latency by route
histogram_quantile(0.95, sum by (le, route) (rate(journal_http_request_duration_seconds_bucket[5m])))
```

The counts live in memory and start again from zero whenever the server starts (`rate()`
copes with the resets).

For a quick look without a dashboard, every request log line carries its route:

```sh
journalctl -u journal | grep -o 'route="[^"]*"' | sort | uniq -c | sort -rn
```

## Licence

Copyright © 2026 Kagimo. Kagimo is free software: you can redistribute it and modify it
under the terms of the GNU Affero General Public License, version 3, as published by the
Free Software Foundation (see [LICENSE](LICENSE)). It comes with no warranty. If you run a
modified version as a service for other people, that licence asks you to offer them your
source.

The client-side cryptography in `frontend/src/crypto` is also published at
[github.com/kagimo-journal/crypto](https://github.com/kagimo-journal/crypto) under the MIT
licence, and may be used under those terms instead.

Third-party components remain under their own licences, including the typefaces (SIL Open
Font License 1.1) and the GeoNames place data (CC BY 4.0).

Enquiries: support@kagimo.com
