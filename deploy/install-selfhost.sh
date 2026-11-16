#!/usr/bin/env bash
# Builds the journal and prints the root steps that install it on kagimo.local as a
# hardened systemd *system* service: a dedicated `journal` user, the binary in
# /usr/local/bin, data in /var/lib/journal, Caddy in front. This script never runs sudo
# and never touches /var/lib/journal, /etc or a running service; copy the printed
# commands and run them yourself.
#
#   deploy/install-selfhost.sh                    build, then print the root steps
#   deploy/install-selfhost.sh --from DIR         also print the steps that migrate an
#                                               existing data directory (journal.db,
#                                               secret.key) from DIR to /var/lib/journal
#   deploy/install-selfhost.sh --no-build         skip the build (use the existing bin/journal)
#   deploy/install-selfhost.sh --dry-run          print the build commands instead of running them
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_SRC="$REPO/bin/journal"
BIN_DST="/usr/local/bin/journal"
UNIT_SRC="$REPO/deploy/journal.service"
UNIT_DST="/etc/systemd/system/journal.service"
CADDY_SRC="$REPO/deploy/Caddyfile"
CADDY_DST="/etc/caddy/conf.d/journal.caddy"
DATA_DST="/var/lib/journal"
SVC_USER="journal"
CA_ROOT="/var/lib/caddy/pki/authorities/local/root.crt"

DRY_RUN=0
BUILD=1
FROM=""
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) BUILD=0 ;;
    --from)
      [[ $# -ge 2 ]] || { echo "--from needs a directory" >&2; exit 2; }
      FROM="$2"
      shift
      ;;
    --from=*) FROM="${1#--from=}" ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
run() {
  if ((DRY_RUN)); then
    printf '    [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

if [[ $EUID -eq 0 ]]; then
  echo "Run this as your normal user, not root: it only builds and prints the root steps." >&2
  exit 1
fi

if ((BUILD)); then
  for tool in go npm make; do
    command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
  done
  say "Building (places dataset if missing, frontend, Go binary)"
  run make -C "$REPO" deps
  if ! run make -C "$REPO" places; then
    echo "    warning: could not build the places dataset (offline?); entries will have no location." >&2
  fi
  run make -C "$REPO" build
fi
if ((!DRY_RUN)) && [[ ! -x "$BIN_SRC" ]]; then
  echo "missing $BIN_SRC; run without --no-build" >&2
  exit 1
fi

if [[ -n "$FROM" ]]; then
  FROM="$(cd "$FROM" 2>/dev/null && pwd)" || { echo "--from: no such directory" >&2; exit 1; }
  for f in journal.db secret.key; do
    [[ -e "$FROM/$f" ]] || echo "    warning: $FROM/$f does not exist" >&2
  done
fi
NOLOGIN="$(command -v nologin || echo /usr/bin/nologin)"
q() { printf '%q' "$1"; }

cat <<EOF

────────────────────────────────────────────────────────────────────────────
 Binary: $BIN_SRC. Run these steps yourself (they need root).

 1. Create the service user (no login shell, no home directory):

      getent passwd $SVC_USER >/dev/null || sudo useradd --system --user-group \\
          --home-dir $DATA_DST --no-create-home --shell $NOLOGIN $SVC_USER

 2. Install the binary and the hardened system unit:

      sudo install -o root -g root -m 0755 $(q "$BIN_SRC") $BIN_DST
      sudo install -o root -g root -m 0644 $(q "$UNIT_SRC") $UNIT_DST
      sudo systemctl daemon-reload
      systemd-analyze security journal.service    # expect an exposure level around 1.0
EOF

if [[ -n "$FROM" ]]; then
  cat <<EOF

 3. Move the existing data from $FROM to $DATA_DST.
    Stop whatever is serving it first (a consistent copy of a live WAL database
    needs the server stopped), e.g. the old user unit:

      systemctl --user disable --now journal.service 2>/dev/null || true
      sudo systemctl stop journal.service 2>/dev/null || true

    Then copy, refusing to overwrite an existing database:

      sudo test ! -e $DATA_DST/journal.db || { echo "$DATA_DST/journal.db exists; not overwriting"; false; } && \\
      sudo install -d -o $SVC_USER -g $SVC_USER -m 0700 $DATA_DST && \\
      sudo sqlite3 $(q "$FROM/journal.db") ".backup '$DATA_DST/journal.db'" && \\
      sudo install -o $SVC_USER -g $SVC_USER -m 0600 $(q "$FROM/secret.key") $DATA_DST/secret.key && \\
      sudo chown $SVC_USER:$SVC_USER $DATA_DST/journal.db && sudo chmod 0600 $DATA_DST/journal.db

    secret.key must travel with journal.db (it decrypts the TOTP secrets). Check:

      sudo ls -la $DATA_DST          # drwx------ journal journal; files -rw------- journal journal

    Keep $FROM until the new service works, then delete it.
EOF
else
  cat <<EOF

 3. (No --from given: the service starts with an empty database in $DATA_DST.
    To move an existing instance, rerun with --from <old data dir>.)
EOF
fi

cat <<EOF

 4. Start the service:

      sudo systemctl enable --now journal.service
      curl -fsS http://127.0.0.1:8080/api/config && echo     # expect {"bootstrap":…}
      journalctl -u journal -e                               # logs

 5. Add the Caddy site for kagimo.local (proxies to 127.0.0.1:8080) and reload Caddy:

      sudo install -d -m 0755 /etc/caddy/conf.d
      sudo install -o root -g root -m 0644 $(q "$CADDY_SRC") $CADDY_DST
      sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
      sudo systemctl reload caddy

    (Caddy's main /etc/caddy/Caddyfile must contain: import /etc/caddy/conf.d/*)

 6. Copy Caddy's local root CA somewhere you can hand it to your devices:

      sudo install -m 0644 $CA_ROOT ~/kagimo-caddy-root.crt
      sudo chown $USER: ~/kagimo-caddy-root.crt

    The CA is created the first time Caddy serves a 'tls internal' site, so do
    step 5 (and open https://kagimo.local once) before this.

 7. Trust that root certificate on every device that will open the journal
    (WebAuthn/passkeys and WebCrypto refuse to work behind a certificate warning):

      this machine:   sudo trust anchor --store ~/kagimo-caddy-root.crt
                      (Firefox keeps its own store: Settings → Privacy & Security →
                       Certificates → View Certificates → Authorities → Import)
      Other Linux:    sudo trust anchor --store kagimo-caddy-root.crt   (Arch/Fedora)
                      sudo cp kagimo-caddy-root.crt /usr/local/share/ca-certificates/ \\
                        && sudo update-ca-certificates                (Debian/Ubuntu)
      macOS:          open it in Keychain Access → System keychain → set to "Always Trust"
      iOS / iPadOS:   AirDrop or mail it, install the profile (Settings → Profile Downloaded),
                      then Settings → General → About → Certificate Trust Settings → enable it
      Android:        Settings → Security → Encryption & credentials → Install a certificate
                      → CA certificate
      Windows:        certmgr.msc → Trusted Root Certification Authorities → Import

 8. kagimo.local must resolve on your devices. It does via mDNS (avahi on this machine;
    macOS/iOS built in; Linux clients need nss-mdns; Android/Windows may need a
    DNS or hosts entry pointing kagimo.local at this machine's LAN address).

 Admin CLI against the installed instance:

      sudo -u $SVC_USER $BIN_DST admin -data $DATA_DST list

 To update later: rerun this script (it rebuilds), then repeat step 2 and
 'sudo systemctl restart journal'.

 Then open https://kagimo.local. On a fresh database the first account becomes the
 admin; it has to add a passkey or authenticator app before it can use the journal.
 Keep its recovery key somewhere safe.
────────────────────────────────────────────────────────────────────────────
EOF
