package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"journal/internal/auth"
	"journal/internal/passkey"
	"journal/internal/store"
)

// When every Argon2 slot is taken (auth.ErrBusy), the answer is 503 busy with a
// Retry-After, whichever handler was hashing and however it wrapped the error.
func TestBusyHashingIs503(t *testing.T) {
	env := newEnv(t)
	for _, err := range []error{auth.ErrBusy, fmt.Errorf("verify passphrase: %w", auth.ErrBusy)} {
		rec := httptest.NewRecorder()
		env.srv.wrap(func(w http.ResponseWriter, r *http.Request) error { return err }).
			ServeHTTP(rec, httptest.NewRequest("POST", "/api/auth/login", nil))
		r := resp{status: rec.Code, header: rec.Header(), body: rec.Body.Bytes()}
		if r.status != http.StatusServiceUnavailable || r.errCode() != "busy" {
			t.Fatalf("%v: %d %s", err, r.status, r.body)
		}
		if got := r.header.Get("Retry-After"); got != busyRetryAfter {
			t.Fatalf("Retry-After = %q, want %q", got, busyRetryAfter)
		}
		if ct := r.header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Fatalf("content type %q", ct)
		}
	}
}

// A recovery reset without a valid token is turned away before any Argon2 is computed:
// the endpoint needs no session, so otherwise anyone could make the server hash at will.
func TestRecoverResetChecksTokenBeforeHashing(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	c := env.client()
	reset := func(token string) resp {
		return c.do("POST", "/api/auth/recover/reset", map[string]any{
			"token": token, "kdf": map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
			"authKey": randB64(32), "wrappedMkPass": sealed(48),
		})
	}
	before := auth.HashCount()
	for _, token := range []string{"", "nope", randB64(32)} {
		if r := reset(token); r.status != 401 || r.errCode() != "invalid_token" {
			t.Fatalf("token %q: %d %s", token, r.status, r.body)
		}
	}
	if n := auth.HashCount() - before; n != 0 {
		t.Fatalf("%d hashes computed for invalid tokens", n)
	}
	// A valid token costs the one hash of the new passphrase key.
	token := c.mustStatus(200, "POST", "/api/auth/recover/verify",
		map[string]any{"username": "alice", "recoveryAuthKey": a.recKey}).json(t)["token"].(string)
	before = auth.HashCount()
	if r := reset(token); r.status != 200 {
		t.Fatalf("reset: %d %s", r.status, r.body)
	}
	if n := auth.HashCount() - before; n != 1 {
		t.Fatalf("%d hashes for a valid reset, want 1", n)
	}
}

// An account holds at most store.MaxCredentials passkeys.
func TestPasskeyLimit(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	for i := 0; i < store.MaxCredentials-1; i++ {
		insertCredential(t, env, "alice", fmt.Sprintf("Key %d", i))
	}
	registerPasskey(t, env, a) // the last one that fits, through the real ceremony
	r := a.c.do("POST", "/api/passkeys/register/begin", map[string]any{"name": "One too many"})
	if r.status != http.StatusConflict || r.errCode() != "passkey_limit" {
		t.Fatalf("begin past the limit: %d %s", r.status, r.body)
	}
	// Removing one makes room.
	var me struct {
		Passkeys []struct {
			ID string `json:"id"`
		} `json:"passkeys"`
	}
	mustUnmarshal(t, a.c.mustStatus(200, "GET", "/api/me", nil).body, &me)
	if len(me.Passkeys) != store.MaxCredentials {
		t.Fatalf("%d passkeys, want %d", len(me.Passkeys), store.MaxCredentials)
	}
	a.c.mustStatus(200, "DELETE", "/api/passkeys/"+me.Passkeys[0].ID, nil)
	a.c.mustStatus(200, "POST", "/api/passkeys/register/begin", map[string]any{"name": "Replacement"})
}

// Beginning sign-ins over and over never gets 503: one address keeps a handful of
// challenges, the oldest making way, and another address's challenge is untouched.
func TestPasskeyBeginNeverRefused(t *testing.T) {
	env := newEnv(t, func(c *Config) { c.AuthRateLimit = 10_000; c.ClientIPHeader = "X-Real-IP" })
	begin := func(ip string) string {
		t.Helper()
		id, _ := env.client().mustStatus(200, "POST", "/api/auth/passkey/begin", nil, withHeader("X-Real-IP", ip)).json(t)["challengeId"].(string)
		if id == "" {
			t.Fatal("no challenge id")
		}
		return id
	}
	// finish with a malformed credential tells a live challenge (which it spends) from a
	// dropped one.
	alive := func(id string) bool {
		t.Helper()
		r := env.client().do("POST", "/api/auth/passkey/finish", map[string]any{"challengeId": id, "credential": map[string]any{}})
		switch r.errCode() {
		case "webauthn_invalid":
			return true
		case "challenge_expired":
			return false
		}
		t.Fatalf("finish: %d %s", r.status, r.body)
		return false
	}
	other := begin("198.51.100.7")
	var ids []string
	for i := 0; i < 3*passkey.MaxPerOwner; i++ {
		ids = append(ids, begin("203.0.113.9"))
	}
	if n := env.srv.challenges.Len(); n != passkey.MaxPerOwner+1 {
		t.Fatalf("%d challenges outstanding, want %d", n, passkey.MaxPerOwner+1)
	}
	if alive(ids[0]) {
		t.Fatal("the flooding address's oldest challenge is still there")
	}
	if !alive(ids[len(ids)-1]) {
		t.Fatal("the flooding address's newest challenge was dropped")
	}
	if !alive(other) {
		t.Fatal("another address's challenge was dropped")
	}
}
