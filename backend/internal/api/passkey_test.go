package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/go-webauthn/webauthn/webauthn"

	"journal/internal/passkey"
	"journal/internal/store"
)

// softAuthenticator is a minimal software WebAuthn authenticator (ES256,
// "none" attestation) used to exercise full ceremonies in tests.
type softAuthenticator struct {
	key        *ecdsa.PrivateKey
	credID     []byte
	userHandle []byte
	rpID       string
	origin     string
	counter    uint32
	// assertFlags overrides the authenticator-data flags of assertions (default UP|UV).
	assertFlags byte
}

func newSoftAuthenticator(t *testing.T, rpID, origin string) *softAuthenticator {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 16)
	rand.Read(id)
	return &softAuthenticator{key: k, credID: id, rpID: rpID, origin: origin}
}

var b64u = base64.RawURLEncoding

func (a *softAuthenticator) clientData(typ, challenge string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": a.origin, "crossOrigin": false})
	return b
}

func (a *softAuthenticator) authData(flags byte, attested []byte) []byte {
	rp := sha256.Sum256([]byte(a.rpID))
	out := append([]byte{}, rp[:]...)
	out = append(out, flags)
	out = binary.BigEndian.AppendUint32(out, a.counter)
	return append(out, attested...)
}

// create answers a registration options object.
func (a *softAuthenticator) create(t *testing.T, options map[string]any) json.RawMessage {
	t.Helper()
	pk := options["publicKey"].(map[string]any)
	challenge := pk["challenge"].(string)
	user := pk["user"].(map[string]any)
	handle, err := b64u.DecodeString(user["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	a.userHandle = handle

	x := a.key.PublicKey.X.FillBytes(make([]byte, 32))
	y := a.key.PublicKey.Y.FillBytes(make([]byte, 32))
	cose, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
	if err != nil {
		t.Fatal(err)
	}
	attested := make([]byte, 16) // zero AAGUID
	attested = binary.BigEndian.AppendUint16(attested, uint16(len(a.credID)))
	attested = append(attested, a.credID...)
	attested = append(attested, cose...)
	authData := a.authData(0x45, attested) // UP | UV | AT
	attObj, err := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": authData})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{
		"id": b64u.EncodeToString(a.credID), "rawId": b64u.EncodeToString(a.credID), "type": "public-key",
		"authenticatorAttachment": "platform",
		"response": map[string]any{
			"clientDataJSON":    b64u.EncodeToString(a.clientData("webauthn.create", challenge)),
			"attestationObject": b64u.EncodeToString(attObj),
			"transports":        []string{"internal"},
		},
		"clientExtensionResults": map[string]any{},
	})
	return b
}

// get answers an assertion options object.
func (a *softAuthenticator) get(t *testing.T, options map[string]any) json.RawMessage {
	t.Helper()
	challenge := options["publicKey"].(map[string]any)["challenge"].(string)
	cd := a.clientData("webauthn.get", challenge)
	flags := a.assertFlags
	if flags == 0 {
		flags = 0x05 // UP | UV
	}
	authData := a.authData(flags, nil)
	cdHash := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, authData...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{
		"id": b64u.EncodeToString(a.credID), "rawId": b64u.EncodeToString(a.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64u.EncodeToString(cd),
			"authenticatorData": b64u.EncodeToString(authData),
			"signature":         b64u.EncodeToString(sig),
			"userHandle":        b64u.EncodeToString(a.userHandle),
		},
		"clientExtensionResults": map[string]any{},
	})
	return b
}

func TestPasskeyRegisterBeginOptions(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	r := a.c.mustStatus(200, "POST", "/api/passkeys/register/begin", map[string]any{"name": "Laptop"}).json(t)
	if r["challengeId"] == "" {
		t.Fatalf("missing challengeId: %v", r)
	}
	pk := r["options"].(map[string]any)["publicKey"].(map[string]any)
	if pk["rp"].(map[string]any)["id"] != "localhost" || pk["rp"].(map[string]any)["name"] != "Journal" {
		t.Fatalf("rp: %v", pk["rp"])
	}
	sel := pk["authenticatorSelection"].(map[string]any)
	if sel["residentKey"] != "required" || sel["requireResidentKey"] != true || sel["userVerification"] != "preferred" {
		t.Fatalf("authenticatorSelection: %v", sel)
	}
	user := pk["user"].(map[string]any)
	handle, _ := b64u.DecodeString(user["id"].(string))
	u, _ := env.st.UserByUsername(context.Background(), "alice")
	if string(handle) != string(u.WebAuthnHandle) || user["name"] != "alice" {
		t.Fatalf("user entity: %v", user)
	}
	if c, _ := pk["challenge"].(string); len(c) < 32 {
		t.Fatalf("challenge too short: %q", c)
	}

	// Unauthenticated callers cannot begin registration.
	env.client().mustStatus(401, "POST", "/api/passkeys/register/begin", map[string]any{"name": "x"})
}

func TestPasskeyLoginBeginOptions(t *testing.T) {
	env := newEnv(t)
	r := env.client().mustStatus(200, "POST", "/api/auth/passkey/begin", nil).json(t)
	pk := r["options"].(map[string]any)["publicKey"].(map[string]any)
	if ac, ok := pk["allowCredentials"]; ok && len(ac.([]any)) != 0 {
		t.Fatalf("discoverable login must not list credentials: %v", ac)
	}
	if pk["rpId"] != "localhost" || pk["challenge"] == "" {
		t.Fatalf("options: %v", pk)
	}
	// Unknown challenge.
	bad := env.client().do("POST", "/api/auth/passkey/finish", map[string]any{"challengeId": "nope", "credential": map[string]any{}})
	if bad.status != 400 || bad.errCode() != "challenge_expired" {
		t.Fatalf("unknown challenge: %d %s", bad.status, bad.body)
	}
}

func TestPasskeyFullCeremony(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	authn := newSoftAuthenticator(t, "localhost", testOrigin)

	begin := a.c.mustStatus(200, "POST", "/api/passkeys/register/begin", map[string]any{"name": "Laptop"}).json(t)
	cred := authn.create(t, begin["options"].(map[string]any))
	fin := a.c.mustStatus(200, "POST", "/api/passkeys/register/finish",
		map[string]any{"challengeId": begin["challengeId"], "name": "Laptop", "credential": cred}).json(t)
	pkey := fin["passkey"].(map[string]any)
	if pkey["name"] != "Laptop" || pkey["prf"] != false || pkey["credentialId"] != b64u.EncodeToString(authn.credID) {
		t.Fatalf("passkey: %v", pkey)
	}
	// The challenge is single use.
	if r := a.c.do("POST", "/api/passkeys/register/finish",
		map[string]any{"challengeId": begin["challengeId"], "name": "Laptop", "credential": cred}); r.status != 400 {
		t.Fatalf("challenge reuse: %d", r.status)
	}

	// Store the PRF-wrapped MK.
	wrap := sealed(48)
	a.c.mustStatus(200, "PUT", "/api/passkeys/"+pkey["id"].(string)+"/prf", map[string]any{"wrappedMk": wrap})

	// Discoverable login on a fresh client.
	c := env.client()
	authn.counter = 5
	lb := c.mustStatus(200, "POST", "/api/auth/passkey/begin", nil).json(t)
	got := c.mustStatus(200, "POST", "/api/auth/passkey/finish",
		map[string]any{"challengeId": lb["challengeId"], "credential": authn.get(t, lb["options"].(map[string]any))}).json(t)
	me := got["me"].(map[string]any)
	if got["status"] != "ok" || me["username"] != "alice" {
		t.Fatalf("passkey login: %v", got)
	}
	wraps := me["keys"].(map[string]any)["passkeyWraps"].([]any)
	if len(wraps) != 1 || wraps[0].(map[string]any)["credentialId"] != b64u.EncodeToString(authn.credID) ||
		wraps[0].(map[string]any)["wrappedMk"].(map[string]any)["ct"] != wrap["ct"] {
		t.Fatalf("passkeyWraps: %v", wraps)
	}
	c.mustStatus(200, "GET", "/api/me", nil)
	stored, _ := env.st.CredentialByCredentialID(context.Background(), authn.credID)
	if stored.SignCount != 5 || stored.LastUsedAt == nil {
		t.Fatalf("sign count / last used not recorded: %+v", stored)
	}

	// A regressed sign counter (possible clone) is rejected.
	authn.counter = 3
	lb = env.client().mustStatus(200, "POST", "/api/auth/passkey/begin", nil).json(t)
	r := env.client().do("POST", "/api/auth/passkey/finish",
		map[string]any{"challengeId": lb["challengeId"], "credential": authn.get(t, lb["options"].(map[string]any))})
	if r.status != 401 {
		t.Fatalf("counter regression accepted: %d %s", r.status, r.body)
	}

	// Passkey login bypasses TOTP (passkey = full login).
	env.enableTOTP(a)
	authn.counter = 10
	c2 := env.client()
	lb = c2.mustStatus(200, "POST", "/api/auth/passkey/begin", nil).json(t)
	c2.mustStatus(200, "POST", "/api/auth/passkey/finish",
		map[string]any{"challengeId": lb["challengeId"], "credential": authn.get(t, lb["options"].(map[string]any))})

	// Disabled accounts cannot sign in with a passkey.
	env.st.SetStatus(context.Background(), env.userID("alice"), store.StatusDisabled, env.clock.Now())
	authn.counter = 11
	c3 := env.client()
	lb = c3.mustStatus(200, "POST", "/api/auth/passkey/begin", nil).json(t)
	if r := c3.do("POST", "/api/auth/passkey/finish",
		map[string]any{"challengeId": lb["challengeId"], "credential": authn.get(t, lb["options"].(map[string]any))}); r.status != 403 {
		t.Fatalf("disabled passkey login: %d %s", r.status, r.body)
	}
}

func TestPasskeyRegisterChallengeBoundToUser(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	b := env.signup("bob")
	begin := a.c.mustStatus(200, "POST", "/api/passkeys/register/begin", map[string]any{"name": "x"}).json(t)
	authn := newSoftAuthenticator(t, "localhost", testOrigin)
	cred := authn.create(t, begin["options"].(map[string]any))
	r := b.c.do("POST", "/api/passkeys/register/finish", map[string]any{"challengeId": begin["challengeId"], "credential": cred})
	if r.status != 400 || r.errCode() != "challenge_expired" {
		t.Fatalf("cross-user challenge: %d %s", r.status, r.body)
	}
}

func TestPasskeyWrongOriginRejected(t *testing.T) {
	env := newEnv(t)
	a := env.signup("alice")
	begin := a.c.mustStatus(200, "POST", "/api/passkeys/register/begin", map[string]any{"name": "x"}).json(t)
	authn := newSoftAuthenticator(t, "localhost", "https://evil.example")
	cred := authn.create(t, begin["options"].(map[string]any))
	r := a.c.do("POST", "/api/passkeys/register/finish", map[string]any{"challengeId": begin["challengeId"], "credential": cred})
	if r.status != 400 || r.errCode() != "webauthn_failed" {
		t.Fatalf("wrong origin: %d %s", r.status, r.body)
	}
}

// insertCredential stores a credential row directly (storage logic tests).
func insertCredential(t *testing.T, env *testEnv, username, name string) string {
	t.Helper()
	id := newUUID()
	credID := make([]byte, 16)
	rand.Read(credID)
	err := env.st.CreateCredential(context.Background(), &store.Credential{
		ID: id, UserID: env.userID(username), CredentialID: credID, PublicKey: []byte{1, 2, 3},
		Transports: []string{"internal", "hybrid"}, Flags: 0x45, Name: name, CreatedAt: env.clock.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPasskeyManagement(t *testing.T) {
	env := newEnv(t)
	alice := env.signup("alice") // active admin
	env.activeUser("bob")
	p1 := insertCredential(t, env, "alice", "Laptop")
	bobKey := insertCredential(t, env, "bob", "Phone")

	me := alice.c.mustStatus(200, "GET", "/api/me", nil).json(t)
	pks := me["passkeys"].([]any)
	if len(pks) != 1 || pks[0].(map[string]any)["id"] != p1 || pks[0].(map[string]any)["prf"] != false || me["hasSecondFactor"] != true {
		t.Fatalf("me passkeys: %v", me)
	}

	cases := []struct {
		name         string
		method, path string
		body         any
		want         int
	}{
		{"rename own", "PATCH", "/api/passkeys/" + p1, map[string]any{"name": "Work laptop"}, 200},
		{"rename too long", "PATCH", "/api/passkeys/" + p1, map[string]any{"name": string(make([]byte, 65))}, 400},
		{"rename foreign", "PATCH", "/api/passkeys/" + bobKey, map[string]any{"name": "x"}, 404},
		{"prf foreign", "PUT", "/api/passkeys/" + bobKey + "/prf", map[string]any{"wrappedMk": sealed(48)}, 404},
		{"prf invalid", "PUT", "/api/passkeys/" + p1 + "/prf", map[string]any{"wrappedMk": "!!"}, 400},
		{"prf own", "PUT", "/api/passkeys/" + p1 + "/prf", map[string]any{"wrappedMk": sealed(48)}, 200},
		{"delete foreign", "DELETE", "/api/passkeys/" + bobKey, nil, 404},
		{"delete malformed id", "DELETE", "/api/passkeys/abc", nil, 404},
		{"delete last factor", "DELETE", "/api/passkeys/" + p1, nil, 409},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if r := alice.c.do(tc.method, tc.path, tc.body); r.status != tc.want {
				t.Fatalf("got %d %s", r.status, r.body)
			}
		})
	}
	me = alice.c.mustStatus(200, "GET", "/api/me", nil).json(t)
	pk := me["passkeys"].([]any)[0].(map[string]any)
	if pk["name"] != "Work laptop" || pk["prf"] != true || len(me["keys"].(map[string]any)["passkeyWraps"].([]any)) != 1 {
		t.Fatalf("after updates: %v", me)
	}

	// With a second passkey, the first can be deleted.
	insertCredential(t, env, "alice", "Key")
	alice.c.mustStatus(200, "DELETE", "/api/passkeys/"+p1, nil)

	// Bob's credential is untouched.
	if c, err := env.st.CredentialForUser(context.Background(), env.userID("bob"), bobKey); err != nil || c.Name != "Phone" {
		t.Fatalf("bob's credential changed: %v %v", c, err)
	}
}

func TestChallengeStore(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_000_000, 0)}
	cs := passkey.NewChallenges(clock.Now)
	cases := []struct {
		name    string
		putKind string
		putUser string
		advance time.Duration
		kind    string
		user    string
		wantErr bool
	}{
		{"match", passkey.KindLogin, "", 0, passkey.KindLogin, "", false},
		{"wrong kind", passkey.KindLogin, "", 0, passkey.KindRegister, "", true},
		{"wrong user", passkey.KindRegister, "u1", 0, passkey.KindRegister, "u2", true},
		{"expired", passkey.KindLogin, "", passkey.ChallengeTTL, passkey.KindLogin, "", true},
		{"just in time", passkey.KindLogin, "", passkey.ChallengeTTL - time.Second, passkey.KindLogin, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, err := cs.Put(tc.putKind, tc.putUser, "ip|192.0.2.1", sessionDataStub())
			if err != nil {
				t.Fatal(err)
			}
			clock.Advance(tc.advance)
			_, err = cs.Take(id, tc.kind, tc.user)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			// Always single use.
			if _, err := cs.Take(id, tc.putKind, tc.putUser); err == nil {
				t.Fatalf("challenge reusable")
			}
		})
	}
	if _, err := cs.Put(passkey.KindLogin, "", "ip|192.0.2.1", sessionDataStub()); err != nil {
		t.Fatal(err)
	}
	clock.Advance(passkey.ChallengeTTL)
	cs.Prune()
	if cs.Len() != 0 {
		t.Fatalf("prune left %d", cs.Len())
	}
}

func sessionDataStub() webauthn.SessionData {
	return webauthn.SessionData{Challenge: "stub-challenge-value-0123456789abcdef"}
}
