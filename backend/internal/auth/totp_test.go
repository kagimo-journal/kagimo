package auth

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

// rfcSecret is the 20-byte ASCII key "12345678901234567890" of the RFC 4226 and
// RFC 6238 (SHA-1) test vectors, base32-encoded.
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

// RFC 4226 appendix D: HOTP values for counters 0-9.
func TestHOTPRFC4226Vectors(t *testing.T) {
	key, err := decodeTOTPSecret(rfcSecret)
	if err != nil || string(key) != "12345678901234567890" {
		t.Fatalf("decode: %q %v", key, err)
	}
	want := []string{"755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"}
	for counter, w := range want {
		if got := hotp(key, uint64(counter)); got != w {
			t.Errorf("counter %d: got %s, want %s", counter, got, w)
		}
	}
}

// RFC 6238 appendix B, SHA-1 rows. The RFC lists 8-digit codes; a 6-digit code is the
// same truncated value modulo 10^6, i.e. the last six digits.
func TestTOTPRFC6238Vectors(t *testing.T) {
	cases := []struct {
		unix   int64
		eight  string
		system string
	}{
		{59, "94287082", "1970-01-01 00:00:59"},
		{1111111109, "07081804", "2005-03-18 01:58:29"},
		{1111111111, "14050471", "2005-03-18 01:58:31"},
		{1234567890, "89005924", "2009-02-13 23:31:30"},
		{2000000000, "69279037", "2033-05-18 03:33:20"},
		{20000000000, "65353130", "2603-10-11 11:33:20"},
	}
	for _, tc := range cases {
		at := time.Unix(tc.unix, 0)
		want := tc.eight[2:]
		got, err := TOTPCode(rfcSecret, at)
		if err != nil || got != want {
			t.Errorf("%s: got %s (%v), want %s", tc.system, got, err, want)
		}
		if step, ok := MatchTOTP(rfcSecret, want, at, 0); !ok || step != tc.unix/TOTPPeriod {
			t.Errorf("%s: MatchTOTP = (%d, %v)", tc.system, step, ok)
		}
	}
}

// Secrets are accepted the way authenticator apps and older rows may hold them.
func TestTOTPSecretForms(t *testing.T) {
	at := time.Unix(59, 0)
	// A 10-byte key encodes to 16 characters unpadded; 11 bytes need padding.
	const short = "GEZDGNBVGY3TQOJQGE" // "12345678901"
	want, err := TOTPCode(short, at)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{short + "======", strings.ToLower(short), " " + short + "\n"} {
		if got, err := TOTPCode(s, at); err != nil || got != want {
			t.Errorf("secret %q: got %s (%v), want %s", s, got, err, want)
		}
	}
	for _, s := range []string{"", "not base32!", "GEZDGNBVGY3TQOJ1"} {
		if _, err := TOTPCode(s, at); err == nil {
			t.Errorf("secret %q accepted", s)
		}
		if _, ok := MatchTOTP(s, "287082", at, 0); ok {
			t.Errorf("secret %q matched", s)
		}
	}
}

func TestNewTOTPSecret(t *testing.T) {
	secret, raw, err := NewTOTPSecret("My Journal", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(secret) != 32 || strings.ContainsAny(secret, "=") || secret != strings.ToUpper(secret) {
		t.Fatalf("secret %q: want 32 unpadded upper-case base32 characters", secret)
	}
	if key, err := decodeTOTPSecret(secret); err != nil || len(key) != 20 {
		t.Fatalf("secret decodes to %d bytes: %v", len(key), err)
	}
	// Byte for byte what enrolled authenticators were given before.
	if want := "otpauth://totp/My%20Journal:alice?algorithm=SHA1&digits=6&issuer=My%20Journal&period=30&secret=" + secret; raw != want {
		t.Fatalf("url = %q\n want %q", raw, want)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Scheme != "otpauth" || u.Host != "totp" || u.Path != "/My Journal:alice" || q.Get("issuer") != "My Journal" || q.Get("secret") != secret {
		t.Fatalf("url parses to %+v %v", u, q)
	}
	other, _, _ := NewTOTPSecret("My Journal", "alice")
	if other == secret {
		t.Fatal("secrets repeat")
	}
	if _, _, err := NewTOTPSecret("", "alice"); err == nil {
		t.Fatal("empty issuer accepted")
	}
}
