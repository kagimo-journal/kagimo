package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"journal/internal/auth"
)

// A session that has not proved a credential recently cannot add or replace
// credentials; POST /api/auth/reauth with the passphrase re-opens the window.
func TestRecentAuthRequiredForCredentialChanges(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	env.enableTOTP(a) // fresh session from sign-up: allowed

	env.clock.Advance(reauthWindow + time.Second)
	sensitive := []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/account/recovery", map[string]any{"recoveryAuthKey": randB64(32), "wrappedMkRecovery": sealed(48)}},
		{"POST", "/api/passkeys/register/begin", map[string]any{"name": "Attacker"}},
		{"PUT", "/api/passkeys/" + newUUID() + "/prf", map[string]any{"wrappedMk": sealed(48)}},
		{"DELETE", "/api/passkeys/" + newUUID(), nil},
		{"POST", "/api/totp/setup", nil},
		{"POST", "/api/totp/enable", map[string]any{"code": "123456"}},
	}
	for _, c := range sensitive {
		r := a.c.do(c.method, c.path, c.body)
		if r.status != http.StatusForbidden || r.errCode() != "reauth_required" {
			t.Fatalf("%s %s with a stale session: %d %s", c.method, c.path, r.status, r.body)
		}
	}
	// Ordinary requests still work with the long-lived session.
	a.c.mustStatus(200, "GET", "/api/me", nil)
	a.c.mustStatus(200, "GET", "/api/entries", nil)

	// A wrong passphrase does not re-open the window.
	r := a.c.do("POST", "/api/auth/reauth", map[string]any{"authKey": randB64(32)})
	if r.status != 401 || r.errCode() != "invalid_credentials" {
		t.Fatalf("reauth with wrong key: %d %s", r.status, r.body)
	}
	a.c.mustStatus(403, "POST", "/api/account/recovery", sensitive[0].body)

	a.c.mustStatus(200, "POST", "/api/auth/reauth", map[string]any{"authKey": a.authKey})
	a.c.mustStatus(200, "POST", "/api/account/recovery", sensitive[0].body)
	a.c.mustStatus(200, "POST", "/api/passkeys/register/begin", map[string]any{"name": "Laptop"})

	// Reauth needs a full session.
	if r := env.client().do("POST", "/api/auth/reauth", map[string]any{"authKey": a.authKey}); r.status != 401 {
		t.Fatalf("reauth without session: %d", r.status)
	}

	// Changing the passphrase proves it too.
	env.clock.Advance(reauthWindow + time.Second)
	newKey := randB64(32)
	a.c.mustStatus(200, "POST", "/api/account/passphrase", map[string]any{
		"currentAuthKey": a.authKey, "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
		"authKey": newKey, "wrappedMkPass": sealed(48),
	})
	a.c.mustStatus(200, "POST", "/api/account/recovery", sensitive[0].body)
}

// TOTP guesses are capped per account, however many IPs (or IPv6 addresses) the
// attacker spreads them over, and an mfa_pending session dies after a few wrong codes.
func TestTOTPGuessingLimitedPerAccount(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	secretStr := env.enableTOTP(a)

	// Each "attacker" uses a different source address (the test server's peer is
	// loopback, so X-Forwarded-For is honoured as Caddy's would be).
	wrong := 0
	for i := 0; wrong < totpFailLimit; i++ {
		c := env.client()
		ip := withHeader("X-Forwarded-For", "203.0.113."+string(rune('1'+i)))
		r := c.do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey}, ip)
		if r.status != 200 || r.json(t)["status"] != "totp_required" {
			t.Fatalf("login %d: %d %s", i, r.status, r.body)
		}
		if r := c.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}, ip); r.errCode() != "invalid_totp" {
			t.Fatalf("guess %d: %d %s", i, r.status, r.body)
		}
		wrong++
	}
	// Now even the right code is refused, from a fresh address.
	c := env.client()
	ip := withHeader("X-Forwarded-For", "198.51.100.7")
	c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey}, ip)
	env.clock.Advance(30 * time.Second)
	code, _ := auth.TOTPCode(secretStr, env.clock.Now())
	if r := c.do("POST", "/api/auth/login/totp", map[string]any{"code": code}, ip); r.status != http.StatusTooManyRequests {
		t.Fatalf("code accepted while the account is locked: %d %s", r.status, r.body)
	}
	// The limit refills over time.
	env.clock.Advance(10 * time.Minute)
	c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey}, ip)
	code, _ = auth.TOTPCode(secretStr, env.clock.Now())
	c.mustStatus(200, "POST", "/api/auth/login/totp", map[string]any{"code": code}, ip)
}

func TestMFAPendingSessionDiscardedAfterWrongCodes(t *testing.T) {
	env := newEnv(t)
	// Use a limit above the per-session cap so only the session cap triggers.
	env.srv.totpFail = auth.NewLimiter(100, 10*time.Minute, env.clock.Now)
	a := env.activeUser("alice")
	env.enableTOTP(a)
	c := env.client()
	c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
	for i := 0; i < mfaSessionFail; i++ {
		if r := c.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}); r.errCode() != "invalid_totp" {
			t.Fatalf("guess %d: %d %s", i, r.status, r.body)
		}
	}
	if r := c.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}); r.status != http.StatusUnauthorized || r.errCode() != "unauthenticated" {
		t.Fatalf("session should be gone: %d %s", r.status, r.body)
	}
}

func TestPassphraseGuessingLimitedPerAccount(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	for i := 0; i < passFailLimit; i++ {
		c := env.client()
		ip := withHeader("X-Forwarded-For", "2001:db8:"+itoa(i)+"::1") // a different /64 each time
		if r := c.do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": randB64(32)}, ip); r.errCode() != "invalid_credentials" {
			t.Fatalf("guess %d: %d %s", i, r.status, r.body)
		}
	}
	r := env.client().do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey},
		withHeader("X-Forwarded-For", "192.0.2.1"))
	if r.status != http.StatusTooManyRequests {
		t.Fatalf("login allowed after %d failures: %d %s", passFailLimit, r.status, r.body)
	}
	// The lock lifts over time (one attempt per 2 minutes) for unrecognised browsers.
	env.clock.Advance(10 * time.Minute)
	stranger := &account{username: "alice", authKey: a.authKey, c: env.client()}
	if r := stranger.login(); r.status != 200 {
		t.Fatalf("after refill: %d %s", r.status, r.body)
	}
}

func TestIPv6RateLimitGroupedByPrefix(t *testing.T) {
	env := newEnv(t)
	c := env.client()
	for i := 0; i < 10; i++ {
		ip := withHeader("X-Forwarded-For", "2001:db8:1:2:"+itoa(i)+"::1") // same /64
		c.mustStatus(200, "POST", "/api/auth/prelogin", map[string]any{"username": "zed"}, ip)
	}
	c.mustStatus(429, "POST", "/api/auth/prelogin", map[string]any{"username": "zed"},
		withHeader("X-Forwarded-For", "2001:db8:1:2:ffff::9"))
	c.mustStatus(200, "POST", "/api/auth/prelogin", map[string]any{"username": "zed"},
		withHeader("X-Forwarded-For", "2001:db8:1:3::1"))

	if got := rateLimitKey("203.0.113.9"); got != "203.0.113.9" {
		t.Fatalf("IPv4 key = %q", got)
	}
	if got := rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"); got != "2001:db8:1:2::/64" {
		t.Fatalf("IPv6 key = %q", got)
	}
}

func TestPasskeyLoginRequiresUserVerification(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	authn := newSoftAuthenticator(t, "localhost", testOrigin)
	begin := a.c.mustStatus(200, "POST", "/api/passkeys/register/begin", map[string]any{"name": "Key"}).json(t)
	a.c.mustStatus(200, "POST", "/api/passkeys/register/finish",
		map[string]any{"challengeId": begin["challengeId"], "name": "Key", "credential": authn.create(t, begin["options"].(map[string]any))})

	c := env.client()
	lb := c.mustStatus(200, "POST", "/api/auth/passkey/begin", nil).json(t)
	pk := lb["options"].(map[string]any)["publicKey"].(map[string]any)
	if pk["userVerification"] != "required" {
		t.Fatalf("userVerification = %v", pk["userVerification"])
	}
	authn.assertFlags = 0x01 // UP only: a security key without PIN
	authn.counter = 1
	if r := c.do("POST", "/api/auth/passkey/finish",
		map[string]any{"challengeId": lb["challengeId"], "credential": authn.get(t, lb["options"].(map[string]any))}); r.status != 401 {
		t.Fatalf("assertion without UV accepted: %d %s", r.status, r.body)
	}
	c.mustStatus(401, "GET", "/api/me", nil)
}

func TestMaintenanceDeletesOrphanBlobs(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	entryID := newUUID()
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": entryID, "header": sealed(40), "body": sealed(40)})
	kept, orphan := newUUID(), newUUID()
	seedBlob(t, env, "alice", kept, entryID, make([]byte, 64))
	// A photo stored for an entry that no longer (or never) exists.
	seedBlob(t, env, "alice", orphan, newUUID(), make([]byte, 64))
	env.clock.Advance(orphanBlobAge + time.Hour)
	env.srv.maintain(context.Background())
	if r := a.c.do("GET", "/api/blobs/"+orphan, nil); r.status != 404 {
		t.Fatalf("orphan blob survived maintenance: %d", r.status)
	}
	a.c.mustStatus(200, "GET", "/api/blobs/"+kept, nil)
}

func itoa(i int) string {
	const digits = "0123456789abcdef"
	if i < 16 {
		return string(digits[i])
	}
	return itoa(i/16) + string(digits[i%16])
}

// With ClientIPHeader set, the edge proxy's header names the client; without it,
// the header is ignored so a caller cannot pick their own rate-limit bucket.
func TestClientIPHeader(t *testing.T) {
	r, _ := http.NewRequest("GET", "/", nil)
	r.RemoteAddr = "172.16.0.2:5000"
	r.Header.Set("X-Real-IP", "203.0.113.7")

	if got := (&Server{}).clientIP(r); got != "172.16.0.2" {
		t.Fatalf("without config: clientIP = %q", got)
	}
	s := &Server{cfg: Config{ClientIPHeader: "X-Real-IP"}}
	if got := s.clientIP(r); got != "203.0.113.7" {
		t.Fatalf("with header: clientIP = %q", got)
	}
	r.Header.Set("X-Real-IP", "not-an-ip")
	if got := s.clientIP(r); got != "172.16.0.2" {
		t.Fatalf("bad header value: clientIP = %q", got)
	}
}
