package api

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"journal/internal/auth"
	"journal/internal/store"
)

func discardLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

func TestConfigBootstrap(t *testing.T) {
	env := newEnv(t)
	c := env.client()
	r := c.mustStatus(200, "GET", "/api/config", nil, withoutCSRF()).json(t)
	if r["rpId"] != "localhost" || r["rpName"] != "Journal" || r["bootstrap"] != true {
		t.Fatalf("unexpected config %v", r)
	}
	env.signup("first")
	r = c.mustStatus(200, "GET", "/api/config", nil).json(t)
	if r["bootstrap"] != false {
		t.Fatalf("bootstrap should be false after first signup: %v", r)
	}
}

func TestConfigReturningBrowser(t *testing.T) {
	env := newEnv(t)
	if r := env.client().mustStatus(200, "GET", "/api/config", nil).json(t); r["returning"] != false {
		t.Fatalf("fresh browser reported as returning: %v", r)
	}
	alice := env.signup("alice") // sets the jdev cookie
	if r := alice.c.mustStatus(200, "GET", "/api/config", nil).json(t); r["returning"] != true {
		t.Fatalf("browser with a device cookie not reported as returning: %v", r)
	}
	alice.c.mustStatus(200, "POST", "/api/auth/logout", nil)
	if r := alice.c.mustStatus(200, "GET", "/api/config", nil).json(t); r["returning"] != true {
		t.Fatalf("signing out should keep the browser recognised: %v", r)
	}
}

func TestSignupBootstrapAndMember(t *testing.T) {
	env := newEnv(t)
	first := env.signup("Alice")
	me := first.c.mustStatus(200, "GET", "/api/me", nil).json(t)
	if me["username"] != "alice" || me["status"] != "active" || me["isAdmin"] != true {
		t.Fatalf("first user should be active admin: %v", me)
	}
	keys := me["keys"].(map[string]any)
	if keys["kdf"].(map[string]any)["salt"] != first.salt {
		t.Fatalf("kdf salt not echoed: %v", keys)
	}
	if _, ok := keys["wrappedMkPass"].(map[string]any)["nonce"]; !ok {
		t.Fatalf("wrappedMkPass not echoed: %v", keys)
	}

	second := env.signup("bob")
	me = second.c.mustStatus(200, "GET", "/api/me", nil).json(t)
	if me["status"] != "active" || me["isAdmin"] != false || me["hasSecondFactor"] != false {
		t.Fatalf("second user should be an active non-admin: %v", me)
	}

	// Usernames are unique case-insensitively.
	c := env.client()
	r := c.do("POST", "/api/signup", map[string]any{
		"username": "BOB", "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
		"authKey": randB64(32), "recoveryAuthKey": randB64(32), "wrappedMkPass": sealed(48), "wrappedMkRecovery": sealed(48),
	})
	if r.status != http.StatusConflict || r.errCode() != "username_taken" {
		t.Fatalf("duplicate username: %d %s", r.status, r.body)
	}
}

func TestSignupValidation(t *testing.T) {
	env := newEnv(t)
	valid := func() map[string]any {
		return map[string]any{
			"username": "carol", "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
			"authKey": randB64(32), "recoveryAuthKey": randB64(32), "wrappedMkPass": sealed(48), "wrappedMkRecovery": sealed(48),
		}
	}
	cases := []struct {
		name   string
		mutate func(m map[string]any)
		code   string
	}{
		{"short username", func(m map[string]any) { m["username"] = "ab" }, "invalid_username"},
		{"bad chars", func(m map[string]any) { m["username"] = "a b!" }, "invalid_username"},
		{"long username", func(m map[string]any) { m["username"] = strings.Repeat("a", 33) }, "invalid_username"},
		{"short authKey", func(m map[string]any) { m["authKey"] = randB64(16) }, "bad_request"},
		{"missing kdf", func(m map[string]any) { delete(m, "kdf") }, "bad_request"},
		{"weak kdf", func(m map[string]any) { m["kdf"] = map[string]any{"salt": randB64(16), "m": 1024, "t": 1, "p": 1} }, "bad_request"},
		{"missing wrap", func(m map[string]any) { delete(m, "wrappedMkPass") }, "bad_request"},
		{"bad wrap nonce", func(m map[string]any) {
			m["wrappedMkRecovery"] = map[string]string{"nonce": randB64(8), "ct": randB64(48)}
		}, "bad_request"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := valid()
			tc.mutate(body)
			r := env.client().do("POST", "/api/signup", body)
			if r.status != http.StatusBadRequest || r.errCode() != tc.code {
				t.Fatalf("got %d %s, want 400 %s", r.status, r.body, tc.code)
			}
		})
	}
}

func TestSignupLoginTOTPFlow(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	secretStr := env.enableTOTP(a)
	enableCode, _ := auth.TOTPCode(secretStr, env.clock.Now())

	me := a.c.mustStatus(200, "GET", "/api/me", nil).json(t)
	if me["totpEnabled"] != true || me["hasSecondFactor"] != true {
		t.Fatalf("totp should be enabled: %v", me)
	}
	a.c.mustStatus(200, "POST", "/api/auth/logout", nil)
	a.c.mustStatus(401, "GET", "/api/me", nil)

	// Passphrase step: TOTP is required and the session is only mfa_pending.
	r := a.login()
	if r.status != 200 || r.json(t)["status"] != "totp_required" {
		t.Fatalf("login: %d %s", r.status, r.body)
	}
	a.c.mustStatus(401, "GET", "/api/me", nil)
	a.c.mustStatus(401, "GET", "/api/entries", nil)

	// The code used to enable TOTP cannot be replayed.
	r = a.c.do("POST", "/api/auth/login/totp", map[string]any{"code": enableCode})
	if r.status != 401 || r.errCode() != "invalid_totp" {
		t.Fatalf("replayed code: %d %s", r.status, r.body)
	}
	// A wrong code fails.
	r = a.c.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"})
	if r.status != 401 {
		t.Fatalf("wrong code: %d %s", r.status, r.body)
	}

	env.clock.Advance(30 * time.Second)
	code, _ := auth.TOTPCode(secretStr, env.clock.Now())
	r = a.c.mustStatus(200, "POST", "/api/auth/login/totp", map[string]any{"code": code})
	got := r.json(t)
	if got["status"] != "ok" || got["me"].(map[string]any)["username"] != "alice" {
		t.Fatalf("totp login: %v", got)
	}
	a.c.mustStatus(200, "GET", "/api/me", nil)

	// A full session cannot use the TOTP step again.
	r = a.c.do("POST", "/api/auth/login/totp", map[string]any{"code": code})
	if r.status != http.StatusConflict {
		t.Fatalf("totp on full session: %d %s", r.status, r.body)
	}

	// The same code is rejected on a new sign-in (replay), even within the skew window.
	other := &account{username: "alice", authKey: a.authKey, c: env.client()}
	if r := other.login(); r.json(t)["status"] != "totp_required" {
		t.Fatalf("second login: %s", r.body)
	}
	r = other.c.do("POST", "/api/auth/login/totp", map[string]any{"code": code})
	if r.status != 401 {
		t.Fatalf("replay on new login: %d %s", r.status, r.body)
	}
	// The previous step's code (skew -1) is also older than the last used step.
	prev, _ := auth.TOTPCode(secretStr, env.clock.Now().Add(-30*time.Second))
	if r := other.c.do("POST", "/api/auth/login/totp", map[string]any{"code": prev}); r.status != 401 {
		t.Fatalf("older step accepted: %d", r.status)
	}
	// Next step (skew +1) is accepted.
	next, _ := auth.TOTPCode(secretStr, env.clock.Now().Add(30*time.Second))
	other.c.mustStatus(200, "POST", "/api/auth/login/totp", map[string]any{"code": next})
}

func TestLoginWithoutTOTP(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	a.c.mustStatus(200, "POST", "/api/auth/logout", nil)
	r := a.login()
	got := r.json(t)
	if r.status != 200 || got["status"] != "ok" || got["me"].(map[string]any)["username"] != "alice" {
		t.Fatalf("login: %d %s", r.status, r.body)
	}
	// Cookie attributes.
	sc := r.header.Get("Set-Cookie")
	for _, want := range []string{"jsid=", "HttpOnly", "SameSite=Strict", "Path=/"} {
		if !strings.Contains(sc, want) {
			t.Fatalf("cookie %q missing %q", sc, want)
		}
	}
	if strings.Contains(sc, "Secure") {
		t.Fatalf("cookie must not be Secure on http origin: %q", sc)
	}
	a.c.mustStatus(200, "GET", "/api/me", nil)
}

func TestSessionRotationOnLogin(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	u := env.st.DB()
	var before int
	u.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&before)
	a.c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
	var after int
	u.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&after)
	if before != 1 || after != 1 {
		t.Fatalf("login should replace the presented session: before=%d after=%d", before, after)
	}
	var hashLen int
	u.QueryRow(`SELECT LENGTH(id_hash) FROM sessions`).Scan(&hashLen)
	if hashLen != 32 {
		t.Fatalf("session ids must be stored hashed, got len %d", hashLen)
	}
}

func TestLoginBadCredentials(t *testing.T) {
	env := newEnv(t)
	env.signup("alice")
	cases := []struct {
		name, username, key string
	}{
		{"wrong key", "alice", randB64(32)},
		{"unknown user", "nobody", randB64(32)},
		{"invalid username", "!!", randB64(32)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := env.client().do("POST", "/api/auth/login", map[string]any{"username": tc.username, "authKey": tc.key})
			if r.status != 401 || r.errCode() != "invalid_credentials" {
				t.Fatalf("got %d %s", r.status, r.body)
			}
		})
	}
}

func TestPreloginFakeSalt(t *testing.T) {
	env := newEnv(t)
	alice := env.signup("alice")
	c := env.client()
	kdf := func(username string) map[string]any {
		return c.mustStatus(200, "POST", "/api/auth/prelogin", map[string]any{"username": username}).json(t)["kdf"].(map[string]any)
	}
	cases := []struct {
		name     string
		username string
		check    func(t *testing.T, k map[string]any)
	}{
		{"known user returns real salt", "alice", func(t *testing.T, k map[string]any) {
			if k["salt"] != alice.salt {
				t.Fatalf("salt %v, want %v", k["salt"], alice.salt)
			}
		}},
		{"known user case-insensitive", "ALICE", func(t *testing.T, k map[string]any) {
			if k["salt"] != alice.salt {
				t.Fatalf("salt %v, want %v", k["salt"], alice.salt)
			}
		}},
		{"unknown user deterministic", "mallory", func(t *testing.T, k map[string]any) {
			again := kdf("mallory")
			if k["salt"] != again["salt"] {
				t.Fatalf("fake salt not deterministic: %v vs %v", k["salt"], again["salt"])
			}
			if other := kdf("trent"); other["salt"] == k["salt"] {
				t.Fatalf("fake salts must differ per username")
			}
			if b, _ := decodeB64(k["salt"].(string)); len(b) != 16 {
				t.Fatalf("fake salt must be 16 bytes, got %d", len(b))
			}
		}},
		{"unknown user same params", "nobody", func(t *testing.T, k map[string]any) {
			if k["m"] != float64(65536) || k["t"] != float64(3) || k["p"] != float64(1) {
				t.Fatalf("params %v", k)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { tc.check(t, kdf(tc.username)) })
	}

	// Determinism across restarts with the same secret.key: fake salt equals HMAC.
	want := b64(env.srv.keys.FakeSalt("mallory"))
	if got := kdf("mallory")["salt"]; got != want {
		t.Fatalf("fake salt %v, want HMAC-derived %v", got, want)
	}
}

func TestRateLimit(t *testing.T) {
	env := newEnv(t)
	env.signup("alice")
	c := env.client()
	for i := 0; i < 10; i++ {
		r := c.do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": randB64(32)})
		if r.status != 401 {
			t.Fatalf("attempt %d: %d %s", i, r.status, r.body)
		}
	}
	r := c.do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": randB64(32)})
	if r.status != http.StatusTooManyRequests || r.errCode() != "rate_limited" {
		t.Fatalf("11th attempt: %d %s", r.status, r.body)
	}
	// Other usernames from the same IP have their own bucket.
	if r := c.do("POST", "/api/auth/login", map[string]any{"username": "bob", "authKey": randB64(32)}); r.status != 401 {
		t.Fatalf("other username: %d", r.status)
	}
	// Prelogin is limited too.
	for i := 0; i < 10; i++ {
		c.mustStatus(200, "POST", "/api/auth/prelogin", map[string]any{"username": "zed"})
	}
	c.mustStatus(429, "POST", "/api/auth/prelogin", map[string]any{"username": "zed"})

	env.clock.Advance(time.Minute)
	if r := c.do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": randB64(32)}); r.status != 401 {
		t.Fatalf("after window: %d", r.status)
	}
}

func TestIPRateLimit(t *testing.T) {
	env := newEnv(t, func(c *Config) { c.IPRateLimit = 5 })
	c := env.client()
	for i := 0; i < 5; i++ {
		c.mustStatus(200, "POST", "/api/auth/prelogin", map[string]any{"username": "user" + string(rune('a'+i))})
	}
	c.mustStatus(429, "POST", "/api/auth/prelogin", map[string]any{"username": "another"})
}

func TestCSRF(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	cases := []struct {
		name   string
		method string
		path   string
		opts   []reqOpt
		want   int
	}{
		{"missing both", "POST", "/api/auth/logout", []reqOpt{withoutCSRF()}, 403},
		{"missing X-Journal", "POST", "/api/entries", []reqOpt{func(r *http.Request) { r.Header.Del("X-Journal") }}, 403},
		{"wrong X-Journal", "POST", "/api/entries", []reqOpt{withHeader("X-Journal", "0")}, 403},
		{"missing Origin", "POST", "/api/entries", []reqOpt{func(r *http.Request) { r.Header.Del("Origin") }}, 403},
		{"wrong Origin", "PUT", "/api/settings", []reqOpt{withHeader("Origin", "https://evil.example")}, 403},
		{"origin with path-like suffix", "DELETE", "/api/entries/" + newUUID(), []reqOpt{withHeader("Origin", testOrigin+".evil.example")}, 403},
		{"signup", "POST", "/api/signup", []reqOpt{withHeader("Origin", "null")}, 403},
		{"GET needs no header", "GET", "/api/me", []reqOpt{withoutCSRF()}, 200},
		{"valid headers", "POST", "/api/auth/prelogin", nil, 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body any = map[string]any{"username": "alice"}
			r := a.c.do(tc.method, tc.path, body, tc.opts...)
			if r.status != tc.want {
				t.Fatalf("got %d, want %d: %s", r.status, tc.want, r.body)
			}
			if tc.want == 403 && r.errCode() != "csrf" {
				t.Fatalf("error code %q, want csrf", r.errCode())
			}
		})
	}
	// The session survived all rejected logout attempts.
	a.c.mustStatus(200, "GET", "/api/me", nil)
}

func TestSecurityHeaders(t *testing.T) {
	env := newEnv(t, func(c *Config) { c.Origin = "https://journal.local" })
	r := env.client().do("GET", "/api/config", nil)
	want := map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"Referrer-Policy":           "no-referrer",
		"Permissions-Policy":        "geolocation=(self), camera=(), microphone=()",
		"Strict-Transport-Security": "max-age=63072000; includeSubDomains",
		"Cache-Control":             "no-store",
	}
	for k, v := range want {
		if got := r.header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if csp := r.header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval'") ||
		!strings.Contains(csp, "frame-ancestors 'none'") || strings.Contains(csp, "fonts.g") || !strings.Contains(csp, "connect-src 'self' https://api.open-meteo.com;") || !strings.Contains(csp, "font-src 'self';") {
		t.Errorf("CSP = %q", csp)
	} else if strings.Contains(csp, "stripe") || strings.Contains(csp, "frame-src") || strings.Count(csp, "https://") != 1 {
		// One outside origin (the weather), and nothing that could load a third party's script or frame.
		t.Errorf("CSP admits an outside origin other than Open-Meteo: %q", csp)
	}
	if r := newEnv(t).client().do("GET", "/api/config", nil); r.header.Get("Strict-Transport-Security") != "" {
		t.Errorf("HSTS must not be sent for http origins")
	}
}

func TestBodyLimit(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	big := map[string]any{"id": newUUID(), "header": sealed(32), "body": sealed(1 << 20)}
	r := a.c.do("POST", "/api/entries", big)
	if r.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %d %s", r.status, r.body)
	}
}

func TestRecoveryFlow(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	secretStr := env.enableTOTP(a)
	env.clock.Advance(30 * time.Second)

	c := env.client()
	// Wrong recovery key.
	r := c.do("POST", "/api/auth/recover/verify", map[string]any{"username": "alice", "recoveryAuthKey": randB64(32)})
	if r.status != 401 || r.errCode() != "invalid_credentials" {
		t.Fatalf("wrong key: %d %s", r.status, r.body)
	}
	// TOTP required when enabled.
	r = c.do("POST", "/api/auth/recover/verify", map[string]any{"username": "alice", "recoveryAuthKey": a.recKey})
	if r.status != 401 || r.errCode() != "totp_required" {
		t.Fatalf("missing totp: %d %s", r.status, r.body)
	}
	code, _ := auth.TOTPCode(secretStr, env.clock.Now())
	got := c.mustStatus(200, "POST", "/api/auth/recover/verify",
		map[string]any{"username": "alice", "recoveryAuthKey": a.recKey, "totpCode": code}).json(t)
	token, _ := got["token"].(string)
	if token == "" || got["wrappedMkRecovery"] == nil {
		t.Fatalf("verify response: %v", got)
	}

	newKey, newSalt := randB64(32), randB64(16)
	reset := map[string]any{
		"token": token, "kdf": map[string]any{"salt": newSalt, "m": 65536, "t": 3, "p": 1},
		"authKey": newKey, "wrappedMkPass": sealed(48),
	}
	got = c.mustStatus(200, "POST", "/api/auth/recover/reset", reset).json(t)
	if got["status"] != "ok" || got["me"].(map[string]any)["keys"].(map[string]any)["kdf"].(map[string]any)["salt"] != newSalt {
		t.Fatalf("reset response: %v", got)
	}
	c.mustStatus(200, "GET", "/api/me", nil)
	// Old sessions are revoked.
	a.c.mustStatus(401, "GET", "/api/me", nil)

	// Token is single use.
	r = env.client().do("POST", "/api/auth/recover/reset", reset)
	if r.status != 401 || r.errCode() != "invalid_token" {
		t.Fatalf("token reuse: %d %s", r.status, r.body)
	}
	// Old passphrase no longer works; new one does.
	if r := a.login(); r.status != 401 {
		t.Fatalf("old passphrase: %d", r.status)
	}
	a.authKey = newKey
	if r := a.login(); r.status != 200 {
		t.Fatalf("new passphrase: %d %s", r.status, r.body)
	}
}

func TestRecoveryTokenExpires(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	c := env.client()
	token := c.mustStatus(200, "POST", "/api/auth/recover/verify",
		map[string]any{"username": "alice", "recoveryAuthKey": a.recKey}).json(t)["token"].(string)
	env.clock.Advance(11 * time.Minute)
	r := c.do("POST", "/api/auth/recover/reset", map[string]any{
		"token": token, "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
		"authKey": randB64(32), "wrappedMkPass": sealed(48),
	})
	if r.status != 401 || r.errCode() != "invalid_token" {
		t.Fatalf("expired token: %d %s", r.status, r.body)
	}
}

func TestChangePassphraseAndRecoveryKey(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	other := &account{username: "alice", authKey: a.authKey, c: env.client()}
	other.c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})

	newKey := randB64(32)
	body := map[string]any{
		"currentAuthKey": randB64(32), "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
		"authKey": newKey, "wrappedMkPass": sealed(48),
	}
	if r := a.c.do("POST", "/api/account/passphrase", body); r.status != 401 {
		t.Fatalf("wrong current key: %d %s", r.status, r.body)
	}
	body["currentAuthKey"] = a.authKey
	a.c.mustStatus(200, "POST", "/api/account/passphrase", body)
	a.c.mustStatus(200, "GET", "/api/me", nil)
	other.c.mustStatus(401, "GET", "/api/me", nil) // other devices signed out
	a.authKey = newKey
	if r := a.login(); r.status != 200 {
		t.Fatalf("login with new passphrase: %d", r.status)
	}

	newRec := randB64(32)
	a.c.mustStatus(200, "POST", "/api/account/recovery", map[string]any{"recoveryAuthKey": newRec, "wrappedMkRecovery": sealed(48)})
	if r := env.client().do("POST", "/api/auth/recover/verify", map[string]any{"username": "alice", "recoveryAuthKey": a.recKey}); r.status != 401 {
		t.Fatalf("old recovery key still valid: %d", r.status)
	}
	env.client().mustStatus(200, "POST", "/api/auth/recover/verify", map[string]any{"username": "alice", "recoveryAuthKey": newRec})
}

func TestTOTPManagement(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	// Enable without setup.
	if r := a.c.do("POST", "/api/totp/enable", map[string]any{"code": "123456"}); r.status != 409 {
		t.Fatalf("enable without setup: %d", r.status)
	}
	setup := a.c.mustStatus(200, "POST", "/api/totp/setup", nil).json(t)
	if !strings.HasPrefix(setup["otpauthUrl"].(string), "otpauth://totp/Journal:alice?") {
		t.Fatalf("otpauthUrl = %v", setup["otpauthUrl"])
	}
	// Secret is encrypted at rest.
	var enc []byte
	env.st.DB().QueryRow(`SELECT totp_pending_enc FROM users WHERE username = 'alice'`).Scan(&enc)
	if len(enc) == 0 || strings.Contains(string(enc), setup["secret"].(string)) {
		t.Fatalf("pending TOTP secret not encrypted at rest")
	}
	if r := a.c.do("POST", "/api/totp/enable", map[string]any{"code": "000000"}); r.status != 401 {
		t.Fatalf("enable with wrong code: %d", r.status)
	}
	code, _ := auth.TOTPCode(setup["secret"].(string), env.clock.Now())
	a.c.mustStatus(200, "POST", "/api/totp/enable", map[string]any{"code": code})
	if r := a.c.do("POST", "/api/totp/setup", nil); r.status != 409 {
		t.Fatalf("setup when enabled: %d", r.status)
	}
	// Active admin with TOTP as the only second factor cannot disable it.
	env.clock.Advance(30 * time.Second)
	code, _ = auth.TOTPCode(setup["secret"].(string), env.clock.Now())
	r := a.c.do("POST", "/api/totp/disable", map[string]any{"code": code})
	if r.status != 409 || r.errCode() != "last_second_factor" {
		t.Fatalf("disable last factor: %d %s", r.status, r.body)
	}

	// A pending user may disable it.
	b := env.signup("bob")
	sec := env.enableTOTP(b)
	env.clock.Advance(30 * time.Second)
	code, _ = auth.TOTPCode(sec, env.clock.Now())
	b.c.mustStatus(200, "POST", "/api/totp/disable", map[string]any{"code": code})
	if me := b.c.mustStatus(200, "GET", "/api/me", nil).json(t); me["totpEnabled"] != false {
		t.Fatalf("totp still enabled: %v", me)
	}
}

func TestDisabledUserCannotLogin(t *testing.T) {
	env := newEnv(t)
	env.signup("admin")
	b := env.activeUser("bob")
	if err := env.st.SetStatus(context.Background(), env.userID("bob"), store.StatusDisabled, env.clock.Now()); err != nil {
		t.Fatal(err)
	}
	b.c.mustStatus(401, "GET", "/api/me", nil)
	r := b.login()
	if r.status != 403 || r.errCode() != "account_disabled" {
		t.Fatalf("disabled login: %d %s", r.status, r.body)
	}
}
