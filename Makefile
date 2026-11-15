# Kagimo: end-to-end encrypted journal.
#
#   make deps     install npm dependencies (frontend, e2e)
#   make places   download GeoNames and build the on-device places dataset (optional; needs
#                 network; without it entries simply get no location)
#   make build    frontend -> backend/web/dist, then the Go binary -> bin/journal
#   make dev      backend on :8081 + Vite dev server on http://localhost:5173 (hot reload);
#                 STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PUBLISHABLE_KEY in .env.local turn billing on
#   make run      build, then serve the production build on http://localhost:8090 (its front page offers the
#                 desktop app once `make desktop-dist` has built an installer)
#   make test-postgres  the Go tests again, against the Postgres database in JOURNAL_TEST_DATABASE_URL
#   make test     go vet + go test, frontend typecheck + vitest, desktop cargo test + clippy, API e2e
#   make smoke    headless-Chromium smoke test of the public pages (needs Chromium)
#   make check    test + smoke
#   make desktop        build the desktop app (Tauri, see desktop/; needs Rust, see mise.toml): frontend ->
#                       desktop/renderer, then a debug build -> desktop/src-tauri/target/debug/kagimo
#   make desktop-run    build the desktop app and open it
#   make desktop-dist   a release build packaged for this platform (dmg, NSIS installer, AppImage/deb)
#                       into desktop/src-tauri/target/release/bundle
#   make desktop-dist-mac  macOS: a universal dmg, signed with the Developer ID certificate and notarised, into
#                          desktop/release; needs the notarytool keychain profile NOTARY_PROFILE (default kagimo)
#   make desktop-smoke  drive the real desktop app through its window (also part of `make check`; Linux: needs a
#                       display, e.g. xvfb-run)
#   make publish-crypto  copy frontend/src/crypto into ../kagimo-crypto (public, MIT) and commit there; never pushes
#
# `dev` and `run` keep their data in .local/ and use their own ports, so they never touch the
# deployed instance (/var/lib/journal, 127.0.0.1:8080 via the system unit in deploy/ + Caddy).

SHELL       := /bin/bash
ROOT        := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BIN         := $(ROOT)/bin/journal
GO          ?= go
NPM         ?= npm
CARGO       ?= cargo
GOFLAGS_BUILD := -trimpath -ldflags "-s -w"

# Overridable, e.g.: make run RUN_ADDR=127.0.0.1:9000 RUN_ORIGIN=http://localhost:9000
RUN_ADDR    ?= 127.0.0.1:8090
RUN_ORIGIN  ?= http://localhost:8090
RUN_DATA    ?= $(ROOT)/.local/run-data
DEV_ADDR    ?= 127.0.0.1:8081
DEV_ORIGIN  ?= http://localhost:5173
DEV_DATA    ?= $(ROOT)/.local/dev-data
DEV_BIN     := $(ROOT)/.local/journal-dev
# Desktop app installers offered on the front page by `run` and `dev`: whatever `make desktop-dist` has built.
DOWNLOADS   ?= $(ROOT)/desktop/release

GO_SOURCES  := $(shell find backend -name '*.go' -o -name '*.sql' -o -name 'go.mod' -o -name 'go.sum' -o -name 'placeholder.html' 2>/dev/null)
FE_SOURCES  := $(shell find frontend/src frontend/public -type f 2>/dev/null) frontend/index.html frontend/vite.config.ts frontend/package.json

PLACES      := frontend/public/places/places.v1.json

.PHONY: all deps places build frontend backend dev run test test-go test-postgres test-frontend test-e2e test-desktop smoke check fmt clean publish-crypto \
	desktop desktop-run desktop-dist desktop-dist-mac desktop-smoke

all: build

# ---- dependencies --------------------------------------------------------------------

deps: frontend/node_modules/.package-lock.json e2e/node_modules/.package-lock.json

frontend/node_modules/.package-lock.json: frontend/package-lock.json
	cd frontend && $(NPM) ci
e2e/node_modules/.package-lock.json: e2e/package-lock.json
	cd e2e && $(NPM) ci
# Not part of `deps`: the Tauri CLI, which only packaging the desktop app needs.
desktop/node_modules/.package-lock.json: desktop/package-lock.json
	cd desktop && $(NPM) ci

# Generated once (cached download in frontend/.cache); delete the file to regenerate.
places: $(PLACES)
$(PLACES): frontend/scripts/build-places.mjs | frontend/node_modules/.package-lock.json
	cd frontend && $(NPM) run places

# ---- build ---------------------------------------------------------------------------------

build: $(BIN)

frontend: backend/web/dist/index.html

backend/web/dist/index.html: frontend/node_modules/.package-lock.json $(FE_SOURCES)
	cd frontend && $(NPM) run build

# The binary embeds backend/web/dist, so it is rebuilt whenever the frontend is.
$(BIN): backend/web/dist/index.html $(GO_SOURCES)
	@mkdir -p $(dir $(BIN))
	cd backend && CGO_ENABLED=0 $(GO) build $(GOFLAGS_BUILD) -o $(BIN) ./cmd/journal

backend: $(BIN)

# ---- desktop app ---------------------------------------------------------------------------------

DESKTOP_SOURCES := $(shell find desktop/src-tauri/src desktop/src-tauri/capabilities -type f 2>/dev/null) \
	desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/build.rs desktop/src-tauri/tauri.conf.json \
	desktop/src-tauri/Info.plist desktop/package.json
DESKTOP_DEBUG   := desktop/src-tauri/target/debug/kagimo

desktop: desktop/renderer/index.html $(DESKTOP_DEBUG)

# The same frontend, built for the desktop app (no service worker; see frontend/vite.config.ts).
desktop/renderer/index.html: frontend/node_modules/.package-lock.json $(FE_SOURCES)
	cd frontend && $(NPM) run build:desktop

# The page's files are built into the binary, so it depends on them too.
$(DESKTOP_DEBUG): desktop/renderer/index.html $(DESKTOP_SOURCES)
	cd desktop/src-tauri && $(CARGO) build
	@touch $@

desktop-run: desktop
	$(DESKTOP_DEBUG)

desktop-dist: desktop/renderer/index.html desktop/node_modules/.package-lock.json
	cd desktop && npx tauri build

# Signing and notarising: desktop/scripts/dist-mac.sh.
NOTARY_PROFILE ?= kagimo
desktop-dist-mac: desktop/renderer/index.html desktop/node_modules/.package-lock.json
	NOTARY_PROFILE=$(NOTARY_PROFILE) desktop/scripts/dist-mac.sh

# Starts its own sync server from bin/journal on 127.0.0.1:18187; journals go in e2e/.tmp.
desktop-smoke: desktop $(BIN) e2e/node_modules/.package-lock.json
	cd e2e && $(NPM) run desktop

# ---- run -------------------------------------------------------------------------------------

run: $(BIN)
	@mkdir -m 700 -p $(RUN_DATA)
	$(BIN) -addr $(RUN_ADDR) -data $(RUN_DATA) -origin $(RUN_ORIGIN) -downloads $(DOWNLOADS)

# Backend (fresh build of the Go code; its origin is the Vite dev server, which proxies
# /api to it) plus Vite with hot reload. Ctrl-C, or either process exiting, stops both.
dev: frontend/node_modules/.package-lock.json
	@mkdir -m 700 -p $(DEV_DATA)
	cd backend && $(GO) build -o $(DEV_BIN) ./cmd/journal
	@trap 'kill $$(jobs -p) 2>/dev/null; wait' EXIT INT TERM; \
	  if [ -f .env.local ]; then eval "$$(grep -E '^STRIPE_(SECRET_KEY|WEBHOOK_SECRET|PUBLISHABLE_KEY)=' .env.local | sed 's/^/export /')"; fi; \
	  $(DEV_BIN) -addr $(DEV_ADDR) -data $(DEV_DATA) -origin $(DEV_ORIGIN) -downloads $(DOWNLOADS) & \
	  ( cd frontend && JOURNAL_API=http://$(DEV_ADDR) exec $(NPM) run dev -- --strictPort ) & \
	  wait -n

# ---- tests -------------------------------------------------------------------------------------

test: test-go test-frontend test-desktop test-e2e

test-go:
	cd backend && test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt: files need formatting"; exit 1; }
	cd backend && $(GO) vet ./...
	cd backend && $(GO) test -count=1 ./...

# Each test makes (and drops) a schema of its own in that database.
test-postgres:
	@test -n "$$JOURNAL_TEST_DATABASE_URL" || { echo "set JOURNAL_TEST_DATABASE_URL to a postgres:// URL"; exit 1; }
	cd backend && $(GO) test -count=1 ./internal/store ./internal/api

test-frontend: frontend/node_modules/.package-lock.json
	cd frontend && $(NPM) run typecheck
	cd frontend && $(NPM) test

test-desktop: desktop/renderer/index.html
	cd desktop/src-tauri && $(CARGO) fmt --check
	cd desktop/src-tauri && $(CARGO) clippy --all-targets -- -D warnings
	cd desktop/src-tauri && $(CARGO) test

# Starts its own server from bin/journal on 127.0.0.1:18181 with a throwaway data dir.
test-e2e: $(BIN) e2e/node_modules/.package-lock.json
	cd e2e && $(NPM) run typecheck
	cd e2e && $(NPM) test

smoke: $(BIN) e2e/node_modules/.package-lock.json
	cd e2e && $(NPM) run smoke

check: test smoke desktop-smoke

publish-crypto:
	deploy/publish-crypto.sh

fmt:
	cd backend && gofmt -w .

clean:
	rm -rf bin e2e/.tmp desktop/renderer desktop/release desktop/src-tauri/target
	find backend/web/dist -mindepth 1 ! -name .gitkeep -delete
