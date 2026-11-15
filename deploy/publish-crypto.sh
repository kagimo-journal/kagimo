#!/usr/bin/env bash
# Copies frontend/src/crypto into the public kagimo-crypto repository and commits it there,
# recording which commit of this repository it came from. It never pushes.
#
#   deploy/publish-crypto.sh                 # public checkout at ../kagimo-crypto
#   CRYPTO_REPO=/path/to/it deploy/publish-crypto.sh
#
# Then review and push:  git -C ../kagimo-crypto show --stat && git -C ../kagimo-crypto push
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/frontend/src/crypto"
DEST="${CRYPTO_REPO:-$ROOT/../kagimo-crypto}"

die() { echo "publish-crypto: $*" >&2; exit 1; }

[ -d "$DEST/.git" ] || die "no git checkout at $DEST (set CRYPTO_REPO)"
[ -z "$(git -C "$DEST" status --porcelain)" ] || die "$DEST has uncommitted changes"

# The recorded source commit must be what's actually copied.
[ -z "$(git -C "$ROOT" status --porcelain -- "$SRC" frontend/package.json)" ] \
  || die "commit your changes to frontend/src/crypto first"
SHA="$(git -C "$ROOT" rev-parse HEAD)"

# The module must stay self-contained: relative imports within it, plus hash-wasm (and vitest in tests).
bad="$(grep -noE "(from|import\() *['\"][^'\"]+['\"]" "$SRC"/*.ts \
  | grep -vE "['\"](\./[a-z]+|hash-wasm|vitest)['\"]$" || true)"
[ -z "$bad" ] || die "imports from outside the module, which won't build in the public repo:"$'\n'"$bad"

# Keep the hash-wasm version identical, since it does the Argon2id.
ver() { node -p "const p=require('$1');(p.dependencies||{})['hash-wasm']||(p.devDependencies||{})['hash-wasm']"; }
[ "$(ver "$ROOT/frontend/package.json")" = "$(ver "$DEST/package.json")" ] \
  || die "hash-wasm versions differ between frontend/package.json and $DEST/package.json"

# Mirror the .ts files exactly (files removed here are removed there).
find "$DEST/src" -maxdepth 1 -name '*.ts' -delete
cp "$SRC"/*.ts "$DEST/src/"

if [ -z "$(git -C "$DEST" status --porcelain)" ]; then
  echo "publish-crypto: already up to date (journal@${SHA:0:12})"
  exit 0
fi

(cd "$DEST" && { [ -d node_modules ] || npm ci; } && npm run --silent typecheck && npm test --silent)

git -C "$DEST" add -A src
git -C "$DEST" commit -q -m "Sync from journal@${SHA:0:12}" -m "Source-Commit: $SHA"
echo "publish-crypto: committed in $DEST:"
git -C "$DEST" show --stat --format='  %s' HEAD | sed 's/^/  /'

# The docs there are written by hand: flag source changes that may need them updated.
last="$(git -C "$DEST" log --skip=1 -n 1 --format='%(trailers:key=Source-Commit,valueonly)' | head -1)"
if [ -n "$last" ] && git -C "$ROOT" cat-file -e "$last" 2>/dev/null \
  && ! git -C "$ROOT" diff --quiet "$last" "$SHA" -- SPEC.md README.md; then
  echo "publish-crypto: SPEC.md or README.md changed since the last sync; check DESIGN.md and THREAT-MODEL.md in $DEST"
fi
echo "Review, then: git -C $DEST push"
