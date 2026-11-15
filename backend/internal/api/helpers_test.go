package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"journal/internal/auth"
	"journal/internal/secret"
	"journal/internal/store"
	"journal/internal/uuid"
)

const testOrigin = "http://localhost:8080"

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type testEnv struct {
	t     *testing.T
	srv   *Server
	ts    *httptest.Server
	st    *store.Store
	clock *fakeClock
	cfg   Config
	keys  *secret.Keyring
}

func newEnv(t *testing.T, mutate ...func(*Config)) *testEnv {
	t.Helper()
	dir := t.TempDir()
	st, closeStore, err := store.OpenForTest(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(closeStore)
	keys, err := secret.LoadOrCreate(filepath.Join(dir, "secret.key"))
	if err != nil {
		t.Fatal(err)
	}
	// Start mid-step so ±30s skew tests are deterministic.
	clock := &fakeClock{t: time.Date(2026, 11, 11, 12, 0, 15, 0, time.UTC)}
	cfg := Config{
		Origin:        testOrigin,
		RPName:        "Journal",
		Now:           clock.Now,
		Logger:        discardLogger(),
		AuthRateLimit: 10,
		IPRateLimit:   10_000,
	}
	for _, m := range mutate {
		m(&cfg)
	}
	srv, err := New(cfg, st, keys)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &testEnv{t: t, srv: srv, ts: ts, st: st, clock: clock, cfg: cfg, keys: keys}
}

// restart replaces the server with a fresh one over the same database and secret key, as
// after a deploy or an idle stop: whatever the old one kept in memory is gone. Clients
// made before keep their cookies and talk to the new server.
func (e *testEnv) restart() {
	e.t.Helper()
	srv, err := New(e.cfg, e.st, e.keys)
	if err != nil {
		e.t.Fatal(err)
	}
	e.ts.Close()
	e.srv = srv
	e.ts = httptest.NewServer(srv.Handler())
	e.t.Cleanup(e.ts.Close)
}

type client struct {
	env *testEnv
	hc  *http.Client
}

func (e *testEnv) client() *client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		e.t.Fatal(err)
	}
	return &client{env: e, hc: &http.Client{Jar: jar}}
}

type resp struct {
	status int
	header http.Header
	body   []byte
}

func (r resp) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("decode %q: %v", r.body, err)
	}
	return m
}

func (r resp) errCode() string {
	var m struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(r.body, &m)
	return m.Error
}

// reqOpt customises a request.
type reqOpt func(*http.Request)

func withoutCSRF() reqOpt {
	return func(r *http.Request) { r.Header.Del("X-Journal"); r.Header.Del("Origin") }
}

func withHeader(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }

func (c *client) raw(method, path string, body io.Reader, contentType string, opts ...reqOpt) resp {
	c.env.t.Helper()
	req, err := http.NewRequest(method, c.env.ts.URL+path, body)
	if err != nil {
		c.env.t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("X-Journal", "1")
	req.Header.Set("Origin", testOrigin)
	for _, o := range opts {
		o(req)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		c.env.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return resp{status: res.StatusCode, header: res.Header, body: b}
}

func (c *client) do(method, path string, body any, opts ...reqOpt) resp {
	c.env.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			c.env.t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	return c.raw(method, path, rdr, "application/json", opts...)
}

func (c *client) mustStatus(want int, method, path string, body any, opts ...reqOpt) resp {
	c.env.t.Helper()
	r := c.do(method, path, body, opts...)
	if r.status != want {
		c.env.t.Fatalf("%s %s: status %d, want %d; body %s", method, path, r.status, want, r.body)
	}
	return r
}

func randB64(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func sealed(ctLen int) map[string]string {
	return map[string]string{"nonce": randB64(12), "ct": randB64(ctLen)}
}

// account holds the client-side secrets of a test user.
type account struct {
	username string
	authKey  string
	recKey   string
	salt     string
	c        *client
}

func (e *testEnv) signup(username string) *account {
	e.t.Helper()
	a := &account{username: username, authKey: randB64(32), recKey: randB64(32), salt: randB64(16), c: e.client()}
	a.c.mustStatus(200, "POST", "/api/signup", map[string]any{
		"username": username, "note": "hello",
		"kdf":     map[string]any{"salt": a.salt, "m": 65536, "t": 3, "p": 1},
		"authKey": a.authKey, "recoveryAuthKey": a.recKey,
		"wrappedMkPass": sealed(48), "wrappedMkRecovery": sealed(48),
	})
	return a
}

func (a *account) login() resp {
	return a.c.do("POST", "/api/auth/login", map[string]any{"username": a.username, "authKey": a.authKey})
}

func (e *testEnv) userID(username string) string {
	e.t.Helper()
	u, err := e.st.UserByUsername(context.Background(), username)
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

// enableTOTP runs setup+enable for the account and returns the secret.
func (e *testEnv) enableTOTP(a *account) string {
	e.t.Helper()
	r := a.c.mustStatus(200, "POST", "/api/totp/setup", nil).json(e.t)
	secretStr := r["secret"].(string)
	code, err := auth.TOTPCode(secretStr, e.clock.Now())
	if err != nil {
		e.t.Fatal(err)
	}
	a.c.mustStatus(200, "POST", "/api/totp/enable", map[string]any{"code": code})
	return secretStr
}

// activeUser signs up a user, gives them a (stored, not usable) passkey as their
// second factor. Passphrase sign-in for such
// a user answers passkey_required.
func (e *testEnv) activeUser(username string) *account {
	e.t.Helper()
	a := e.signup(username)
	insertCredential(e.t, e, username, "Test key")
	u, err := e.st.UserByUsername(context.Background(), username)
	if err != nil {
		e.t.Fatal(err)
	}
	if u.Status != store.StatusActive {
		if err := e.st.SetStatus(context.Background(), u.ID, store.StatusActive, e.clock.Now()); err != nil {
			e.t.Fatal(err)
		}
	}
	return a
}

func newUUID() string { return uuid.New() }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
