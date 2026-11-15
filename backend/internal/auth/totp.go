package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTP parameters (SPEC §5): RFC 6238 with HMAC-SHA1, 30s period, 6 digits, ±1 step skew.
const (
	TOTPPeriod = 30
	TOTPSkew   = 1

	totpDigits    = 6
	totpModulus   = 1_000_000
	totpSecretLen = 20
)

var b32NoPadding = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret generates a new base32 TOTP secret (160 bits, unpadded) and its otpauth:// URL.
func NewTOTPSecret(issuer, account string) (secret, otpauthURL string, err error) {
	if issuer == "" || account == "" {
		return "", "", errors.New("auth: totp issuer and account are required")
	}
	raw := make([]byte, totpSecretLen)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	secret = b32NoPadding.EncodeToString(raw)
	u := url.URL{
		Scheme: "otpauth",
		Host:   "totp",
		Path:   "/" + issuer + ":" + account,
		// Spaces as %20, not +: some authenticator apps show a + literally.
		RawQuery: "algorithm=SHA1&digits=6&issuer=" + url.PathEscape(issuer) +
			fmt.Sprintf("&period=%d&secret=%s", TOTPPeriod, secret),
	}
	return secret, u.String(), nil
}

// TOTPStep returns the time step for t.
func TOTPStep(t time.Time) int64 { return t.Unix() / TOTPPeriod }

// decodeTOTPSecret decodes a base32 secret as authenticator apps write it: either
// case, with or without padding.
func decodeTOTPSecret(secret string) ([]byte, error) {
	s := strings.TrimRight(strings.ToUpper(strings.TrimSpace(secret)), "=")
	key, err := b32NoPadding.DecodeString(s)
	if err != nil || len(key) == 0 {
		return nil, errors.New("auth: totp secret is not base32")
	}
	return key, nil
}

// hotp is RFC 4226: HMAC-SHA1 of the counter, dynamically truncated to six digits.
func hotp(key []byte, counter uint64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, value%totpModulus)
}

// MatchTOTP checks code against secret at now ±skew and returns the matching step.
// Steps <= lastStep are never accepted (replay protection); the caller must then
// atomically record the returned step as used.
func MatchTOTP(secret, code string, now time.Time, lastStep int64) (int64, bool) {
	if len(code) != totpDigits {
		return 0, false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	key, err := decodeTOTPSecret(secret)
	if err != nil {
		return 0, false
	}
	cur := TOTPStep(now)
	var (
		matched int64
		found   bool
	)
	// Evaluate every candidate step to keep timing independent of which one matches.
	for d := int64(-TOTPSkew); d <= TOTPSkew; d++ {
		step := cur + d
		if step < 0 {
			continue
		}
		want := hotp(key, uint64(step))
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 && step > lastStep && !found {
			matched, found = step, true
		}
	}
	return matched, found
}

// TOTPCode generates the code for secret at t (used by tests and tooling).
func TOTPCode(secret string, t time.Time) (string, error) {
	key, err := decodeTOTPSecret(secret)
	if err != nil {
		return "", err
	}
	step := TOTPStep(t)
	if step < 0 {
		return "", errors.New("auth: time before the unix epoch")
	}
	return hotp(key, uint64(step)), nil
}
