// Package api implements the journal HTTP API (SPEC §5) and the security
// middleware around it (SPEC §7).
package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"journal/internal/auth"
	"journal/internal/passkey"
	"journal/internal/secret"
	"journal/internal/store"
)

// Config configures the API server.
type Config struct {
	Origin string // full origin, e.g. https://kagimo.local
	RPID   string // WebAuthn RP id; defaults to the origin's host
	RPName string // WebAuthn RP name and TOTP issuer

	// Static serves the SPA for non-/api paths. Optional.
	Static http.Handler
	// Logger receives request logs. Defaults to slog.Default().
	Logger *slog.Logger
	// Now is the clock; defaults to time.Now. Tests override it.
	Now func() time.Time

	// Rate limit for credential-checking endpoints per IP+username (default 10/min).
	AuthRateLimit int
	// Rate limit across credential-checking endpoints per IP (default 60/min).
	IPRateLimit int

	// ClientIPHeader, if set, names a request header holding the client IP that a trusted
	// edge proxy sets (e.g. "X-Real-IP"). Only set it when every request passes through
	// that proxy and the proxy overwrites the header.
	ClientIPHeader string

	// Downloads is a folder of desktop app installers to offer on the front page and serve
	// at /download/{name} (see downloads.go). Empty: none offered.
	Downloads string
	// DownloadsRepo ("owner/name") offers the installers of that GitHub repository's latest
	// release instead, linking to them on GitHub (downloads_github.go). Takes precedence
	// over Downloads.
	DownloadsRepo string
	// GitHubAPI is the GitHub API base URL; defaults to https://api.github.com. Tests override it.
	GitHubAPI string

	// Billing configures paid plans (see BillingConfig). Zero value: billing off.
	Billing BillingConfig
}

// Server is the HTTP API.
type Server struct {
	cfg        Config
	store      *store.Store
	keys       *secret.Keyring
	wa         *webauthn.WebAuthn
	challenges *passkey.Challenges
	authLimit  *auth.Limiter
	ipLimit    *auth.Limiter
	// Per-account failure counters, independent of the caller's IP (see failureLimits).
	passFail *auth.Limiter // wrong passphrases per account (keyed by username), unrecognised devices
	devFail  *auth.Limiter // wrong passphrases per (user, recognised device)
	totpFail *auth.Limiter // wrong TOTP codes per user, short term
	// Calls that reach Stripe, per user.
	billingLimit *auth.Limiter
	log          *slog.Logger
	metrics      *apiMetrics
	releases     releaseCache // Config.DownloadsRepo
	secure       bool
	handler      http.Handler
}

// Body size limits (SPEC §7).
const (
	maxJSONBody = 1 << 20
	maxBlobBody = 15 << 20
)

// Session lifetimes.
const (
	sessionTTL    = 30 * 24 * time.Hour
	mfaPendingTTL = 10 * time.Minute
	recoveryTTL   = 10 * time.Minute
	// reauthWindow is how long after proving a credential a session may make
	// security-sensitive account changes (SPEC §5.1 "Re-authentication").
	reauthWindow = 10 * time.Minute
	// orphanBlobAge is how old an unattached blob must be before maintenance deletes it.
	orphanBlobAge = 24 * time.Hour
	// tombstoneAge is how long deletions stay in the change feed. A device away for longer
	// gets 410 cursor_expired and resyncs from scratch (SPEC §5.2).
	tombstoneAge = 90 * 24 * time.Hour
)

// Per-account failure limits. They apply on top of the per-IP limits so that
// spreading guesses over many addresses does not help.
//
// The two that bound guessing at a six-digit code survive a restart, because they are
// kept in the database: the escalating TOTP lockout (users row) and the count of wrong
// answers per mfa_pending session (sessions row). The others are token buckets in
// memory. A restart refills those, which hands out a few more guesses at a passphrase
// (already stretched with Argon2id in the browser) or five more at a code, and every
// one of those five still counts towards the lockout.
const (
	passFailLimit  = 30 // wrong passphrases per account per hour (unrecognised devices)
	devFailLimit   = 10 // wrong passphrases per recognised device per hour
	totpFailLimit  = 5  // wrong TOTP codes per account per 10 minutes
	mfaSessionFail = 5  // wrong second-step answers before an mfa_pending session is discarded
)

// Escalating TOTP lockout (L3): wrong codes counted per account in a 24 h window. The
// count and the lock are stored in the users row (store.TOTPFailures).
var totpLockSteps = []auth.LockoutStep{
	{Failures: 10, Lock: time.Hour},
	{Failures: 20, Lock: 24 * time.Hour},
}

const totpLockWindow = 24 * time.Hour

var totpLock = auth.Lockout{Window: totpLockWindow, Steps: totpLockSteps}

// totpLockState converts the stored failure count to the lockout rule's state.
func totpLockState(f store.TOTPFailures) auth.LockoutState {
	return auth.LockoutState{WindowStart: f.WindowStart, Failures: f.Count, LockedUntil: f.LockedUntil}
}

// New creates the API server.
func New(cfg Config, st *store.Store, keys *secret.Keyring) (*Server, error) {
	u, err := url.Parse(cfg.Origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" && u.Path != "/" {
		return nil, fmt.Errorf("invalid origin %q: must be scheme://host[:port]", cfg.Origin)
	}
	cfg.Origin = u.Scheme + "://" + u.Host
	if cfg.RPID == "" {
		cfg.RPID = u.Hostname()
	}
	if cfg.RPName == "" {
		cfg.RPName = "Kagimo"
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.AuthRateLimit <= 0 {
		cfg.AuthRateLimit = 10
	}
	if cfg.IPRateLimit <= 0 {
		cfg.IPRateLimit = 60
	}
	if cfg.Billing.FreeBytes <= 0 {
		cfg.Billing.FreeBytes = DefaultFreeBytes
	}
	if cfg.Billing.FreeDays <= 0 {
		cfg.Billing.FreeDays = DefaultFreeDays
	}
	if cfg.Billing.PaidBytes <= 0 {
		cfg.Billing.PaidBytes = DefaultPaidBytes
	}
	wa, err := passkey.New(cfg.RPID, cfg.RPName, cfg.Origin)
	if err != nil {
		return nil, fmt.Errorf("webauthn config: %w", err)
	}
	s := &Server{
		cfg:          cfg,
		store:        st,
		keys:         keys,
		wa:           wa,
		challenges:   passkey.NewChallenges(cfg.Now),
		authLimit:    auth.NewLimiter(cfg.AuthRateLimit, time.Minute, cfg.Now),
		ipLimit:      auth.NewLimiter(cfg.IPRateLimit, time.Minute, cfg.Now),
		passFail:     auth.NewLimiter(passFailLimit, time.Hour, cfg.Now),
		devFail:      auth.NewLimiter(devFailLimit, time.Hour, cfg.Now),
		totpFail:     auth.NewLimiter(totpFailLimit, 10*time.Minute, cfg.Now),
		billingLimit: auth.NewLimiter(30, time.Minute, cfg.Now),
		log:          cfg.Logger,
		secure:       u.Scheme == "https",
	}
	s.metrics = newAPIMetrics(cfg.Now)
	s.handler = s.middleware(s.routes())
	return s, nil
}

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler { return s.handler }

// Origin returns the normalised configured origin.
func (s *Server) Origin() string { return s.cfg.Origin }

// RunMaintenance periodically purges expired sessions, recovery tokens and
// WebAuthn challenges, and deletes orphaned blobs, until ctx is cancelled.
func (s *Server) RunMaintenance(ctx context.Context) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		s.maintain(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// maintain runs one maintenance pass.
func (s *Server) maintain(ctx context.Context) {
	s.challenges.Prune()
	if err := s.store.DeleteExpired(ctx, s.cfg.Now()); err != nil && !errors.Is(err, context.Canceled) {
		s.log.Error("maintenance", "err", err)
	}
	if n, err := s.store.DeleteOrphanBlobs(ctx, s.cfg.Now().Add(-orphanBlobAge)); err != nil && !errors.Is(err, context.Canceled) {
		s.log.Error("maintenance: orphan blobs", "err", err)
	} else if n > 0 {
		s.log.Info("maintenance: deleted orphan blobs", "count", n)
	}
	if n, err := s.store.PruneTombstones(ctx, s.cfg.Now().Add(-tombstoneAge)); err != nil && !errors.Is(err, context.Canceled) {
		s.log.Error("maintenance: tombstones", "err", err)
	} else if n > 0 {
		s.log.Info("maintenance: pruned tombstones", "count", n)
	}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	h := func(pattern string, fn handlerFunc) { mux.Handle(pattern, tagRoute(pattern, s.wrap(fn))) }

	// Public.
	h("GET /api/config", s.handleConfig)
	h("POST /api/auth/prelogin", s.handlePrelogin)
	h("POST /api/auth/login", s.handleLogin)
	h("POST /api/auth/login/totp", s.withSession(accessMFAPending, s.handleLoginTOTP))
	h("POST /api/auth/login/passkey/begin", s.withSession(accessMFAPending, s.handleLoginPasskeyBegin))
	h("POST /api/auth/login/passkey/finish", s.withSession(accessMFAPending, s.handleLoginPasskeyFinish))
	h("POST /api/auth/passkey/begin", s.handlePasskeyLoginBegin)
	h("POST /api/auth/passkey/finish", s.handlePasskeyLoginFinish)
	h("POST /api/signup", s.handleSignup)
	h("POST /api/auth/recover/verify", s.handleRecoverVerify)
	h("POST /api/auth/recover/reset", s.handleRecoverReset)
	h("POST /api/auth/logout", s.handleLogout)
	h("POST /api/auth/reauth", s.withSession(accessAny, s.handleReauth))
	// Stripe → server; authenticated by its signature, exempt from the CSRF check.
	h("POST "+webhookPath, s.handleBillingWebhook)

	// Any authenticated user (pending or active).
	h("GET /api/me", s.withSession(accessAny, s.handleMe))
	// Changes that add or replace a way into the account need a recent proof of a
	// credential (recentAuth); the finish step of passkey registration is bound to a
	// challenge that was only issued under one. Disabling TOTP and changing the
	// passphrase prove a credential in the request itself.
	h("POST /api/passkeys/register/begin", s.withSession(accessAny, s.recentAuth(s.handlePasskeyRegisterBegin)))
	h("POST /api/passkeys/register/finish", s.withSession(accessAny, s.handlePasskeyRegisterFinish))
	h("PUT /api/passkeys/{id}/prf", s.withSession(accessAny, s.recentAuth(s.handlePasskeySetPRF)))
	h("PATCH /api/passkeys/{id}", s.withSession(accessAny, s.handlePasskeyRename))
	h("DELETE /api/passkeys/{id}", s.withSession(accessAny, s.recentAuth(s.handlePasskeyDelete)))
	h("POST /api/totp/setup", s.withSession(accessAny, s.recentAuth(s.handleTOTPSetup)))
	h("POST /api/totp/enable", s.withSession(accessAny, s.recentAuth(s.handleTOTPEnable)))
	h("POST /api/totp/disable", s.withSession(accessAny, s.handleTOTPDisable))
	h("POST /api/account/passphrase", s.withSession(accessAny, s.handleChangePassphrase))
	h("POST /api/account/recovery", s.withSession(accessAny, s.recentAuth(s.handleRegenerateRecovery)))

	// Active users only.
	h("GET /api/entries", s.withSession(accessActive, s.handleListEntries))
	h("POST /api/entries", s.withSession(accessActive, s.handleCreateEntry))
	h("GET /api/entries/{id}", s.withSession(accessActive, s.handleGetEntry))
	h("PUT /api/entries/{id}", s.withSession(accessActive, s.handleUpdateEntry))
	h("DELETE /api/entries/{id}", s.withSession(accessActive, s.handleDeleteEntry))
	h("POST /api/blobs", s.withSession(accessActive, s.handleUploadBlob))
	h("GET /api/blobs/{id}", s.withSession(accessActive, s.handleGetBlob))
	h("DELETE /api/blobs/{id}", s.withSession(accessActive, s.handleDeleteBlob))
	h("GET /api/settings", s.withSession(accessActive, s.handleGetSettings))
	h("PUT /api/settings", s.withSession(accessActive, s.handlePutSettings))
	h("GET /api/sync", s.withSession(accessActive, s.handleSync))
	h("POST /api/billing/checkout", s.withSession(accessActive, s.handleBillingCheckout))
	h("POST /api/billing/portal", s.withSession(accessActive, s.handleBillingPortal))
	h("POST /api/billing/sync", s.withSession(accessActive, s.handleBillingSync))

	// Admin only. Everything that changes something (disabling or deleting an account,
	// granting free access, minting or revoking invites) also needs a recent proof of a
	// credential, so a stolen or unattended admin session cannot do it on its own.
	h("GET /api/admin/users", s.withSession(accessAdmin, s.handleAdminListUsers))
	h("POST /api/admin/users/{id}/{action}", s.withSession(accessAdmin, s.recentAuth(s.handleAdminAction)))
	h("DELETE /api/admin/users/{id}", s.withSession(accessAdmin, s.recentAuth(s.handleAdminDeleteUser)))
	h("GET /api/admin/stats", s.withSession(accessAdmin, s.handleAdminStats))
	h("GET /api/admin/invites", s.withSession(accessAdmin, s.handleAdminListInvites))
	h("POST /api/admin/invites", s.withSession(accessAdmin, s.recentAuth(s.handleAdminCreateInvite)))
	h("DELETE /api/admin/invites/{id}", s.withSession(accessAdmin, s.recentAuth(s.handleAdminDeleteInvite)))

	// Unknown API paths get a JSON 404 rather than the SPA.
	h("/api/", func(w http.ResponseWriter, r *http.Request) error {
		return errNotFound
	})
	h("GET /download/{name}", s.handleDownload)
	if s.cfg.Static != nil {
		mux.Handle("/", s.cfg.Static)
	}
	return mux
}

// --- middleware ---

// Fonts are self-hosted (@fontsource), so no third-party font origins are allowed. The one
// outside origin is Open-Meteo, which the browser asks for the weather when that's turned on.
// The policy is the same whatever the configuration: in particular it never admits Stripe
// (payment happens on Stripe's own hosted page, in another tab), so no third-party script
// can run in the origin that holds the journal's keys.
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"font-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://api.open-meteo.com; " +
	"frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

func (s *Server) middleware(next http.Handler) http.Handler {
	return s.recoverPanics(s.logRequests(s.securityHeaders(s.csrf(next))))
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "geolocation=(self), camera=(), microphone=()")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		if s.secure {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		if isAPI(r.URL.Path) {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// webhookPath receives Stripe events. It has no session and is verified by signature.
const webhookPath = "/api/billing/webhook"

// csrf enforces SPEC §5: every state-changing request must carry X-Journal: 1
// and an Origin equal to the configured origin.
func (s *Server) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == webhookPath {
			next.ServeHTTP(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if r.Header.Get("X-Journal") != "1" || r.Header.Get("Origin") != s.cfg.Origin {
				writeError(w, errf(http.StatusForbidden, "csrf", "missing or invalid X-Journal / Origin header"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// logRequests logs method, path (without query), the route pattern, status and duration, and
// counts the request in the metrics. Bodies and query strings are never logged.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		r, ri := withReqInfo(r)
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		dur := time.Since(start)
		s.metrics.observe(r, ri, rec.status, rec.bytes, dur, s.cfg.Now())
		s.log.Info("http", "method", r.Method, "path", r.URL.Path, "route", ri.route, "status", rec.status,
			"bytes", rec.bytes, "dur", dur.Round(time.Microsecond))
	})
}

func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.log.Error("panic", "path", r.URL.Path, "panic", v)
				writeError(w, errInternal)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func isAPI(path string) bool { return path == "/api" || strings.HasPrefix(path, "/api/") }
