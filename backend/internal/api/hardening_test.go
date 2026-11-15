package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"journal/internal/auth"
	"journal/internal/store"
)

// registerPasskey runs a real registration ceremony for a (its session must have
// recent authentication) and returns the software authenticator.
func registerPasskey(t *testing.T, env *testEnv, a *account) *softAuthenticator {
	t.Helper()
	authn := newSoftAuthenticator(t, "localhost", testOrigin)
	begin := a.c.mustStatus(200, "POST", "/api/passkeys/register/begin", map[string]any{"name": "Key"}).json(t)
	a.c.mustStatus(200, "POST", "/api/passkeys/register/finish", map[string]any{
		"challengeId": begin["challengeId"], "name": "Key", "credential": authn.create(t, begin["options"].(map[string]any)),
	})
	return authn
}

// passkeyStep runs /api/auth/login/passkey/begin + finish on c with authn.
func passkeyStep(t *testing.T, c *client, authn *softAuthenticator) resp {
	t.Helper()
	b := c.mustStatus(200, "POST", "/api/auth/login/passkey/begin", nil).json(t)
	authn.counter++
	return c.do("POST", "/api/auth/login/passkey/finish", map[string]any{
		"challengeId": b["challengeId"], "credential": authn.get(t, b["options"].(map[string]any)),
	})
}

func pendingSessions(t *testing.T, env *testEnv, userID string) int {
	t.Helper()
	var n int
	if err := env.st.DB().QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = ? AND state = ?`,
		userID, store.SessionMFAPending).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// H1: a passkey-only account must complete a passkey assertion after the passphrase.
func TestPassphraseLoginRequiresPasskeyStep(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	authn := registerPasskey(t, env, a)
	aliceID := env.userID("alice")

	c := env.client()
	r := c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey}).json(t)
	if !reflect.DeepEqual(r, map[string]any{"status": "passkey_required"}) {
		t.Fatalf("login: %v", r)
	}
	c.mustStatus(401, "GET", "/api/me", nil)
	c.mustStatus(401, "GET", "/api/entries", nil)
	if r := c.do("POST", "/api/auth/login/totp", map[string]any{"code": "123456"}); r.status != 409 || r.errCode() != "totp_not_enabled" {
		t.Fatalf("totp step on passkey-only account: %d %s", r.status, r.body)
	}

	// Options: only alice's credential, user verification required.
	b := c.mustStatus(200, "POST", "/api/auth/login/passkey/begin", nil).json(t)
	pk := b["options"].(map[string]any)["publicKey"].(map[string]any)
	allow, _ := pk["allowCredentials"].([]any)
	if pk["userVerification"] != "required" || len(allow) != 1 ||
		allow[0].(map[string]any)["id"] != b64u.EncodeToString(authn.credID) {
		t.Fatalf("options: %v", pk)
	}

	// A discoverable-login challenge cannot complete the step.
	lb := env.client().mustStatus(200, "POST", "/api/auth/passkey/begin", nil).json(t)
	authn.counter++
	if r := c.do("POST", "/api/auth/login/passkey/finish", map[string]any{
		"challengeId": lb["challengeId"], "credential": authn.get(t, lb["options"].(map[string]any)),
	}); r.status != 400 || r.errCode() != "challenge_expired" {
		t.Fatalf("discoverable challenge accepted: %d %s", r.status, r.body)
	}

	// Another account's passkey is refused.
	bob := env.signup("bob")
	bobAuthn := registerPasskey(t, env, bob)
	if r := passkeyStep(t, c, bobAuthn); r.status != 401 || r.errCode() != "passkey_failed" {
		t.Fatalf("foreign passkey accepted: %d %s", r.status, r.body)
	}
	// An assertion without user verification is refused.
	authn.assertFlags = 0x01
	if r := passkeyStep(t, c, authn); r.status != 401 || r.errCode() != "passkey_failed" {
		t.Fatalf("assertion without UV accepted: %d %s", r.status, r.body)
	}
	authn.assertFlags = 0

	if n := pendingSessions(t, env, aliceID); n != 1 {
		t.Fatalf("pending sessions before finish: %d", n)
	}
	got := passkeyStep(t, c, authn)
	if got.status != 200 {
		t.Fatalf("finish: %d %s", got.status, got.body)
	}
	if m := got.json(t); m["status"] != "ok" || m["me"].(map[string]any)["username"] != "alice" {
		t.Fatalf("finish body: %v", m)
	}
	if !strings.Contains(strings.Join(got.header.Values("Set-Cookie"), "\n"), "jdev=") {
		t.Fatalf("full sign-in did not set the device cookie")
	}
	// The session was rotated: the mfa_pending one is gone.
	if n := pendingSessions(t, env, aliceID); n != 0 {
		t.Fatalf("pending session survived: %d", n)
	}
	c.mustStatus(200, "GET", "/api/entries", nil)
	if r := c.do("POST", "/api/auth/login/passkey/begin", nil); r.status != 409 || r.errCode() != "no_mfa_pending" {
		t.Fatalf("begin on a full session: %d %s", r.status, r.body)
	}
	env.client().mustStatus(401, "POST", "/api/auth/login/passkey/begin", nil)
}

// H1: an mfa_pending session is discarded after too many failed passkey steps.
func TestPasskeyStepFailuresDiscardSession(t *testing.T) {
	env := newEnv(t, func(c *Config) { c.AuthRateLimit = 1000 })
	a := env.signup("alice")
	registerPasskey(t, env, a)
	mallory := newSoftAuthenticator(t, "localhost", testOrigin)
	mallory.userHandle = []byte("whatever")
	c := env.client()
	c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
	for i := 0; i < mfaSessionFail; i++ {
		if r := passkeyStep(t, c, mallory); r.errCode() != "passkey_failed" {
			t.Fatalf("attempt %d: %d %s", i, r.status, r.body)
		}
	}
	if r := c.do("POST", "/api/auth/login/passkey/begin", nil); r.status != 401 {
		t.Fatalf("session should be gone: %d %s", r.status, r.body)
	}
}

// H1: with both TOTP and passkeys, either completes the sign-in.
func TestPassphraseLoginEitherSecondFactor(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	secretStr := env.enableTOTP(a)
	authn := registerPasskey(t, env, a)

	c := env.client()
	r := c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey}).json(t)
	if !reflect.DeepEqual(r, map[string]any{"status": "totp_required", "passkeyAllowed": true}) {
		t.Fatalf("login: %v", r)
	}
	if got := passkeyStep(t, c, authn); got.status != 200 {
		t.Fatalf("passkey step: %d %s", got.status, got.body)
	}
	c.mustStatus(200, "GET", "/api/entries", nil)

	c2 := env.client()
	c2.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
	env.clock.Advance(30 * time.Second)
	code, _ := auth.TOTPCode(secretStr, env.clock.Now())
	c2.mustStatus(200, "POST", "/api/auth/login/totp", map[string]any{"code": code})
	c2.mustStatus(200, "GET", "/api/entries", nil)
}

// H1(c): active admins without a second factor only reach the "any status" endpoints.
// Members don't need one.
func TestSecondFactorRequiredForActiveAccess(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice") // bootstrap admin, no second factor yet
	for _, p := range []string{"/api/entries", "/api/settings", "/api/admin/users", "/api/admin/stats"} {
		if r := a.c.do("GET", p, nil); r.status != http.StatusForbidden || r.errCode() != "second_factor_required" {
			t.Fatalf("%s: %d %s", p, r.status, r.body)
		}
	}
	if me := a.c.mustStatus(200, "GET", "/api/me", nil).json(t); me["hasSecondFactor"] != false || me["status"] != "active" {
		t.Fatalf("me: %v", me)
	}
	// Passphrase sign-in without a second factor gives a (restricted) full session.
	c := env.client()
	if r := c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey}).json(t); r["status"] != "ok" {
		t.Fatalf("login: %v", r)
	}
	c.mustStatus(403, "GET", "/api/entries", nil)
	env.enableTOTP(a)
	a.c.mustStatus(200, "GET", "/api/entries", nil)
	a.c.mustStatus(200, "GET", "/api/admin/users", nil)

	// A member approved without a second factor syncs straight away, and may drop the
	// one they add later.
	b := env.signup("bob")
	if err := env.st.SetStatus(context.Background(), env.userID("bob"), store.StatusActive, env.clock.Now()); err != nil {
		t.Fatal(err)
	}
	b.c.mustStatus(200, "GET", "/api/entries", nil)
	b.c.mustStatus(403, "GET", "/api/admin/users", nil)
}

// M1: oversized or malformed usernames never become map keys.
func TestHugeUsernameDoesNotBecomeAKey(t *testing.T) {
	env := newEnv(t)
	env.signup("alice")
	huge := strings.Repeat("a", (1<<20)-200)
	c := env.client()
	c.mustStatus(200, "POST", "/api/auth/prelogin", map[string]any{"username": huge})
	if r := c.do("POST", "/api/auth/login", map[string]any{"username": huge, "authKey": randB64(32)}); r.status != 401 || r.errCode() != "invalid_credentials" {
		t.Fatalf("login: %d %s", r.status, r.body)
	}
	if r := c.do("POST", "/api/auth/recover/verify", map[string]any{"username": huge, "recoveryAuthKey": randB64(32)}); r.status != 401 {
		t.Fatalf("recover: %d %s", r.status, r.body)
	}
	c.mustStatus(200, "POST", "/api/auth/prelogin", map[string]any{"username": "bad name\x1b"})
	for name, l := range map[string]*auth.Limiter{"auth": env.srv.authLimit, "ip": env.srv.ipLimit,
		"passFail": env.srv.passFail, "devFail": env.srv.devFail} {
		for _, k := range l.Keys() {
			if len(k) > 128 || strings.Contains(k, "\x1b") {
				t.Fatalf("%s limiter holds a client-controlled key of %d bytes: %.60q", name, len(k), k)
			}
		}
	}
	// Normalisation still applies to valid names.
	if r := c.mustStatus(200, "POST", "/api/auth/prelogin", map[string]any{"username": "  ALICE "}).json(t); r["kdf"] == nil {
		t.Fatalf("prelogin: %v", r)
	}
}

// M2: an attacker who exhausts the account-wide passphrase limit does not lock
// out the owner's recognised device; the device has its own (smaller) bucket.
func TestAccountLockDoesNotBlockRecognisedDevice(t *testing.T) {
	env := newEnv(t)
	owner := env.signup("alice") // signup sets the device cookie
	bob := env.signup("bob")

	r := owner.login()
	sc := strings.Join(r.header.Values("Set-Cookie"), "\n")
	for _, want := range []string{"jdev=", "HttpOnly", "SameSite=Strict", "Path=/api/", "Max-Age=31536000"} {
		if !strings.Contains(sc, want) {
			t.Fatalf("device cookie %q missing %q", sc, want)
		}
	}

	for i := 0; i < passFailLimit; i++ {
		ip := withHeader("X-Forwarded-For", "2001:db8:"+itoa(i)+"::1")
		if r := env.client().do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": randB64(32)}, ip); r.errCode() != "invalid_credentials" {
			t.Fatalf("guess %d: %d %s", i, r.status, r.body)
		}
	}
	// An unrecognised browser is locked out, even with the right passphrase…
	if r := env.client().do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": owner.authKey},
		withHeader("X-Forwarded-For", "192.0.2.1")); r.status != http.StatusTooManyRequests {
		t.Fatalf("unrecognised browser: %d %s", r.status, r.body)
	}
	// …and so is one carrying another account's device cookie.
	bob.c.mustStatus(429, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": owner.authKey})
	// A tampered cookie is not recognised.
	tampered := env.client()
	jar := owner.c.hc.Jar.Cookies(mustURL(t, env.ts.URL+"/api/"))
	found := false
	for _, ck := range jar {
		if ck.Name == deviceCookieName {
			found = true
			v := []byte(ck.Value)
			v[0] ^= 1
			tampered.hc.Jar.SetCookies(mustURL(t, env.ts.URL+"/api/"), []*http.Cookie{{Name: deviceCookieName, Value: string(v), Path: "/api/"}})
		}
	}
	if !found {
		t.Fatalf("owner has no device cookie")
	}
	if r := tampered.do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": owner.authKey},
		withHeader("X-Forwarded-For", "192.0.2.9")); r.status != http.StatusTooManyRequests {
		t.Fatalf("tampered cookie recognised: %d %s", r.status, r.body)
	}
	// The owner's recognised device still gets in.
	if r := owner.login(); r.status != 200 || r.json(t)["status"] != "ok" {
		t.Fatalf("owner device blocked: %d %s", r.status, r.body)
	}
	// Reauth from the owner's device is not blocked either.
	owner.c.mustStatus(200, "POST", "/api/auth/reauth", map[string]any{"authKey": owner.authKey})

	// A recognised device has its own failure bucket.
	env.clock.Advance(time.Minute) // fresh per-IP window
	for i := 0; i < devFailLimit; i++ {
		if r := owner.c.do("POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": randB64(32)}); r.errCode() != "invalid_credentials" {
			t.Fatalf("device guess %d: %d %s", i, r.status, r.body)
		}
	}
	env.clock.Advance(time.Minute)
	if r := owner.login(); r.status != http.StatusTooManyRequests {
		t.Fatalf("device bucket not enforced: %d %s", r.status, r.body)
	}

}

// M2: unknown usernames run through the same failure counter, so the sequence of
// answers is identical to a real account's.
func TestUnknownUsernameIndistinguishable(t *testing.T) {
	env := newEnv(t)
	env.signup("alice")
	run := func(username string) []string {
		var seq []string
		for i := 0; i < passFailLimit+3; i++ {
			ip := withHeader("X-Forwarded-For", "2001:db8:"+itoa(i)+"::1")
			r := env.client().do("POST", "/api/auth/login", map[string]any{"username": username, "authKey": randB64(32)}, ip)
			seq = append(seq, fmt.Sprintf("%d %s", r.status, r.errCode()))
		}
		return seq
	}
	known, unknown := run("alice"), run("nobody")
	if !reflect.DeepEqual(known, unknown) {
		t.Fatalf("known and unknown differ:\n%v\n%v", known, unknown)
	}
	if known[passFailLimit-1] != "401 invalid_credentials" || known[passFailLimit] != "429 rate_limited" {
		t.Fatalf("unexpected sequence: %v", known)
	}
}

// L1: control characters in the signup note are refused.
func TestSignupRejectsControlCharacters(t *testing.T) {
	env := newEnv(t)
	for _, note := range []string{"hi\x1b[2J", "line\nbreak", "bell\x07", "rtl‮evil", "c1\u009b"} {
		r := env.client().do("POST", "/api/signup", map[string]any{
			"username": "carol", "note": note, "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
			"authKey": randB64(32), "recoveryAuthKey": randB64(32), "wrappedMkPass": sealed(48), "wrappedMkRecovery": sealed(48),
		})
		if r.status != 400 || r.errCode() != "invalid_note" {
			t.Fatalf("note %q: %d %s", note, r.status, r.body)
		}
	}
	env.client().mustStatus(200, "POST", "/api/signup", map[string]any{
		"username": "carol", "note": "Hi — it's Carol 👋🏽 (book club)", "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
		"authKey": randB64(32), "recoveryAuthKey": randB64(32), "wrappedMkPass": sealed(48), "wrappedMkRecovery": sealed(48),
	})
}

// L2: outstanding recovery tokens die with recovery-key rotation, passphrase
// change and a completed reset.
func TestRecoveryTokensRevoked(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	uid := env.userID("alice")
	recKey := a.recKey
	issue := func() string {
		return env.client().mustStatus(200, "POST", "/api/auth/recover/verify",
			map[string]any{"username": "alice", "recoveryAuthKey": recKey}).json(t)["token"].(string)
	}
	reset := func(token string) resp {
		return env.client().do("POST", "/api/auth/recover/reset", map[string]any{
			"token": token, "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
			"authKey": randB64(32), "wrappedMkPass": sealed(48),
		})
	}
	tokens := func() int {
		n, err := env.st.CountRecoveryTokens(context.Background(), uid)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}

	// Recovery-key rotation.
	tok := issue()
	recKey = randB64(32)
	a.c.mustStatus(200, "POST", "/api/account/recovery", map[string]any{"recoveryAuthKey": recKey, "wrappedMkRecovery": sealed(48)})
	if n := tokens(); n != 0 {
		t.Fatalf("tokens after rotation: %d", n)
	}
	if r := reset(tok); r.status != 401 || r.errCode() != "invalid_token" {
		t.Fatalf("token survived rotation: %d %s", r.status, r.body)
	}

	// Passphrase change.
	tok = issue()
	newKey := randB64(32)
	a.c.mustStatus(200, "POST", "/api/account/passphrase", map[string]any{
		"currentAuthKey": a.authKey, "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
		"authKey": newKey, "wrappedMkPass": sealed(48),
	})
	if r := reset(tok); r.status != 401 || r.errCode() != "invalid_token" {
		t.Fatalf("token survived passphrase change: %d %s", r.status, r.body)
	}

	// A completed reset revokes the other outstanding tokens.
	t1, t2 := issue(), issue()
	if r := reset(t1); r.status != 200 {
		t.Fatalf("reset: %d %s", r.status, r.body)
	}
	if n := tokens(); n != 0 {
		t.Fatalf("tokens after reset: %d", n)
	}
	if r := reset(t2); r.status != 401 || r.errCode() != "invalid_token" {
		t.Fatalf("second token survived reset: %d %s", r.status, r.body)
	}
}

// L3: escalating TOTP lockout per account.
func TestTOTPEscalatingLockout(t *testing.T) {
	env := newEnv(t, func(c *Config) { c.AuthRateLimit = 10_000 })
	// Isolate the escalating lockout from the short-term limits.
	env.srv.totpFail = auth.NewLimiter(10_000, 10*time.Minute, env.clock.Now)
	a := env.signup("alice")
	secretStr := env.enableTOTP(a)
	authn := registerPasskey(t, env, a)
	code := func() string {
		env.clock.Advance(30 * time.Second)
		c, _ := auth.TOTPCode(secretStr, env.clock.Now())
		return c
	}

	attacker := env.client()
	signIn := func() {
		attacker.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
	}
	wrong := func(n int) {
		for i := 0; i < n; i++ {
			// A sign-in attempt is discarded at mfaSessionFail wrong answers: start a new
			// one before that, so only the account-wide lockout is exercised here.
			if i%(mfaSessionFail-1) == 0 {
				signIn()
			}
			if r := attacker.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}); r.errCode() != "invalid_totp" {
				t.Fatalf("wrong code %d: %d %s", i, r.status, r.body)
			}
		}
	}
	wrong(totpLockSteps[0].Failures)
	r := attacker.do("POST", "/api/auth/login/totp", map[string]any{"code": code()})
	if r.status != 429 || r.errCode() != "totp_locked" || r.json(t)["lockedUntil"] == nil {
		t.Fatalf("not locked after %d failures: %d %s", totpLockSteps[0].Failures, r.status, r.body)
	}
	// The lock applies to the owner's recognised device too…
	owner := a.c
	owner.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
	if r := owner.do("POST", "/api/auth/login/totp", map[string]any{"code": code()}); r.errCode() != "totp_locked" {
		t.Fatalf("owner totp during lock: %d %s", r.status, r.body)
	}
	// …but the owner can finish with a passkey,
	if r := passkeyStep(t, owner, authn); r.status != 200 {
		t.Fatalf("passkey during lock: %d %s", r.status, r.body)
	}
	// or recover with the recovery key plus a code.
	env.client().mustStatus(200, "POST", "/api/auth/recover/verify",
		map[string]any{"username": "alice", "recoveryAuthKey": a.recKey, "totpCode": code()})

	// After an hour the lock lifts; ten more failures in the window lock for a day.
	env.clock.Advance(time.Hour)
	wrong(totpLockSteps[1].Failures - totpLockSteps[0].Failures)
	env.clock.Advance(2 * time.Hour)
	signIn()
	if r := attacker.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}); r.errCode() != "totp_locked" {
		t.Fatalf("not locked for a day: %d %s", r.status, r.body)
	}
	env.clock.Advance(23 * time.Hour)
	c := env.client()
	c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
	c.mustStatus(200, "POST", "/api/auth/login/totp", map[string]any{"code": code()})
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// The escalating TOTP lockout is kept in the database: a restart (a deploy, or the machine
// stopping when idle) neither lifts a lock nor forgets the failures counted so far.
func TestTOTPLockoutSurvivesRestart(t *testing.T) {
	env := newEnv(t, func(c *Config) { c.AuthRateLimit = 10_000 })
	isolate := func() { env.srv.totpFail = auth.NewLimiter(10_000, 10*time.Minute, env.clock.Now) }
	isolate()
	a := env.signup("alice")
	secretStr := env.enableTOTP(a)
	code := func() string {
		env.clock.Advance(30 * time.Second)
		c, _ := auth.TOTPCode(secretStr, env.clock.Now())
		return c
	}
	attacker := env.client()
	wrong := func(n int) {
		for i := 0; i < n; i++ {
			if i%(mfaSessionFail-1) == 0 {
				attacker.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
			}
			if r := attacker.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}); r.errCode() != "invalid_totp" {
				t.Fatalf("wrong code %d: %d %s", i, r.status, r.body)
			}
		}
	}
	tryCode := func() resp {
		c := env.client()
		c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
		return c.do("POST", "/api/auth/login/totp", map[string]any{"code": code()})
	}

	// Failures short of the first step are remembered across a restart…
	wrong(totpLockSteps[0].Failures - 1)
	env.restart()
	isolate()
	wrong(1)
	r := tryCode()
	if r.status != 429 || r.errCode() != "totp_locked" {
		t.Fatalf("failures were forgotten by the restart: %d %s", r.status, r.body)
	}
	until, _ := r.json(t)["lockedUntil"].(string)
	if until == "" {
		t.Fatalf("no lockedUntil: %s", r.body)
	}

	// …and so is the lock itself, with the same end.
	env.restart()
	isolate()
	r = tryCode()
	if r.status != 429 || r.errCode() != "totp_locked" || r.json(t)["lockedUntil"] != until {
		t.Fatalf("lock did not survive the restart: %d %s (want lockedUntil %s)", r.status, r.body, until)
	}

	// It lifts on schedule, and the count carries on to the 24 h step.
	env.clock.Advance(time.Hour)
	wrong(totpLockSteps[1].Failures - totpLockSteps[0].Failures)
	env.restart()
	isolate()
	env.clock.Advance(2 * time.Hour)
	if r := tryCode(); r.errCode() != "totp_locked" {
		t.Fatalf("not locked for a day after the restart: %d %s", r.status, r.body)
	}
	// A correct code after the lock clears the stored state.
	env.clock.Advance(23 * time.Hour)
	if r := tryCode(); r.status != 200 {
		t.Fatalf("code after the lock: %d %s", r.status, r.body)
	}
	u, err := env.st.UserByUsername(context.Background(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if f := u.TOTPFailures; f.Count != 0 || !f.LockedUntil.IsZero() || !f.WindowStart.IsZero() {
		t.Fatalf("failure state not cleared: %+v", f)
	}
}

// The wrong answers given to an mfa_pending session are counted in its row: a restart
// does not hand the session a fresh set of guesses.
func TestMFASessionFailuresSurviveRestart(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	env.enableTOTP(a)
	c := env.client()
	c.mustStatus(200, "POST", "/api/auth/login", map[string]any{"username": "alice", "authKey": a.authKey})
	for i := 0; i < mfaSessionFail-1; i++ {
		if r := c.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}); r.errCode() != "invalid_totp" {
			t.Fatalf("guess %d: %d %s", i, r.status, r.body)
		}
	}
	env.restart()
	if n := pendingSessions(t, env, env.userID("alice")); n != 1 {
		t.Fatalf("pending sessions after restart: %d", n)
	}
	// One more wrong answer is the last this session gets.
	if r := c.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}); r.errCode() != "invalid_totp" {
		t.Fatalf("last guess: %d %s", r.status, r.body)
	}
	if n := pendingSessions(t, env, env.userID("alice")); n != 0 {
		t.Fatalf("session survived %d wrong answers across a restart", mfaSessionFail)
	}
	if r := c.do("POST", "/api/auth/login/totp", map[string]any{"code": "000000"}); r.status != http.StatusUnauthorized || r.errCode() != "unauthenticated" {
		t.Fatalf("session should be gone: %d %s", r.status, r.body)
	}
}
