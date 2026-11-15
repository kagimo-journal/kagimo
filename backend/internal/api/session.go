package api

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"journal/internal/auth"
	"journal/internal/store"
)

const cookieName = "jsid"

// access describes what a route requires of the caller's session.
type access int

const (
	accessMFAPending access = iota // a session awaiting the second sign-in step (TOTP or passkey)
	accessAny                      // full session (an admin may still lack a second factor)
	accessActive                   // full session, user active with a second factor
	accessAdmin                    // full session, active admin with a second factor
)

// reqCtx carries the authenticated caller into handlers.
type reqCtx struct {
	user *store.User
	sess *store.Session
}

type ctxKey struct{}

func caller(r *http.Request) *reqCtx {
	rc, _ := r.Context().Value(ctxKey{}).(*reqCtx)
	return rc
}

// withSession authenticates the request's session cookie and enforces level.
func (s *Server) withSession(level access, next handlerFunc) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		sess, err := s.sessionFromRequest(r)
		if err != nil {
			return err
		}
		if sess == nil {
			return errUnauthenticated
		}
		if level == accessMFAPending {
			if sess.State != store.SessionMFAPending {
				return errf(http.StatusConflict, "no_mfa_pending", "no sign-in awaiting a code")
			}
		} else if sess.State != store.SessionFull {
			return errUnauthenticated
		}
		user, err := s.store.UserByID(r.Context(), sess.UserID)
		if errors.Is(err, store.ErrNotFound) {
			return errUnauthenticated
		}
		if err != nil {
			return err
		}
		if user.Status == store.StatusDisabled {
			// Sessions are revoked on disable; this is defence in depth.
			_ = s.store.DeleteUserSessions(r.Context(), user.ID, nil)
			s.clearCookie(w)
			return errDisabled
		}
		if level == accessAdmin && !user.IsAdmin {
			return errForbidden
		}
		if (level == accessActive || level == accessAdmin) && user.IsAdmin {
			// A second factor is optional for members but required for administrators, who
			// can disable and delete other accounts: an admin without a passkey or
			// TOTP (the bootstrap admin, or a fresh promotion) only gets the "any status"
			// endpoints until they have set one up.
			ok, err := s.hasSecondFactor(r.Context(), user)
			if err != nil {
				return err
			}
			if !ok {
				return errSecondFactorRequired
			}
		}
		now := s.cfg.Now()
		if now.Sub(sess.LastSeenAt) > time.Minute {
			_ = s.store.TouchSession(r.Context(), sess.IDHash, now)
			_ = s.store.TouchUser(r.Context(), user.ID, now)
		}
		if ri := info(r); ri != nil {
			ri.userID = user.ID
		}
		ctx := context.WithValue(r.Context(), ctxKey{}, &reqCtx{user: user, sess: sess})
		return next(w, r.WithContext(ctx))
	}
}

// sessionFromRequest returns the live session for the request cookie, or nil.
func (s *Server) sessionFromRequest(r *http.Request) (*store.Session, error) {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" || len(c.Value) > 128 {
		return nil, nil
	}
	sess, err := s.store.SessionByHash(r.Context(), auth.HashToken(c.Value), s.cfg.Now())
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	return sess, err
}

var errSecondFactorRequired = errf(http.StatusForbidden, "second_factor_required",
	"set up a passkey or an authenticator app to continue")

// hasSecondFactor reports whether the user has TOTP enabled or any passkey.
func (s *Server) hasSecondFactor(ctx context.Context, u *store.User) (bool, error) {
	if u.TOTPEnabled() {
		return true, nil
	}
	n, err := s.store.CountCredentials(ctx, u.ID)
	return n > 0, err
}

var errReauthRequired = errf(http.StatusForbidden, "reauth_required",
	"confirm your passphrase to make this change")

// recentAuth wraps a withSession handler and requires the session to have proved a
// credential within reauthWindow. A stolen or unattended session cookie alone can
// then not add or replace credentials (passkeys, TOTP, recovery key), nor, on an
// administrator's session, act on other accounts or invites.
func (s *Server) recentAuth(next handlerFunc) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		rc := caller(r)
		if rc == nil || rc.sess.AuthAt.IsZero() || s.cfg.Now().Sub(rc.sess.AuthAt) > reauthWindow {
			return errReauthRequired
		}
		return next(w, r)
	}
}

// startSession rotates the session: any session presented by the request is
// deleted, and a new one is created and set as the cookie.
func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID, state string) error {
	if c, err := r.Cookie(cookieName); err == nil && c.Value != "" && len(c.Value) <= 128 {
		if err := s.store.DeleteSession(r.Context(), auth.HashToken(c.Value)); err != nil {
			return err
		}
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		return err
	}
	now := s.cfg.Now()
	ttl := sessionTTL
	if state == store.SessionMFAPending {
		ttl = mfaPendingTTL
	}
	sess := &store.Session{IDHash: hash, UserID: userID, State: state, CreatedAt: now, ExpiresAt: now.Add(ttl), LastSeenAt: now}
	if state == store.SessionFull {
		// Every full session starts from a credential check (sign-in, sign-up, recovery).
		sess.AuthAt = now
	}
	if err := s.store.CreateSession(r.Context(), sess); err != nil {
		return err
	}
	if state == store.SessionFull {
		_ = s.store.TouchUser(r.Context(), userID, now)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		Expires:  now.Add(ttl),
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteStrictMode,
	})
	return nil
}

func (s *Server) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteStrictMode,
	})
}

// clientIP returns the caller's IP. If Config.ClientIPHeader is set (a header that
// a trusted edge proxy sets, overwriting any client-supplied value), that header is
// used. Otherwise, when the direct peer is loopback (the local reverse proxy, Caddy), the
// right-most X-Forwarded-For entry is used.
func (s *Server) clientIP(r *http.Request) string {
	if h := s.cfg.ClientIPHeader; h != "" {
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get(h))); ip != nil {
			return ip.String()
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if fwd := net.ParseIP(strings.TrimSpace(parts[len(parts)-1])); fwd != nil {
				return fwd.String()
			}
		}
	}
	if ip != nil {
		return ip.String()
	}
	return host
}

// rateLimitKey groups addresses for rate limiting: IPv4 per address, IPv6 per /64
// (one customer prefix), so rotating addresses inside a prefix does not help.
func rateLimitKey(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.To4() != nil {
		return ip
	}
	return parsed.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// rateLimit applies the per-IP and per-IP+subject limits for credential-checking endpoints.
func (s *Server) rateLimit(r *http.Request, scope, subject string) error {
	ip := rateLimitKey(s.clientIP(r))
	if !s.ipLimit.Allow("ip|" + ip) {
		return errRateLimited
	}
	if !s.authLimit.Allow(scope + "|" + ip + "|" + subject) {
		return errRateLimited
	}
	return nil
}
