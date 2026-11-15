package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"journal/internal/auth"
	"journal/internal/uuid"
)

// apiError is an error with an HTTP status and a stable machine-readable code.
type apiError struct {
	status int
	code   string
	msg    string
	extra  map[string]any
}

func (e *apiError) Error() string { return e.code + ": " + e.msg }

func errf(status int, code, format string, args ...any) *apiError {
	return &apiError{status: status, code: code, msg: fmt.Sprintf(format, args...)}
}

var (
	errNotFound        = errf(http.StatusNotFound, "not_found", "not found")
	errUnauthenticated = errf(http.StatusUnauthorized, "unauthenticated", "sign in required")
	errBadCredentials  = errf(http.StatusUnauthorized, "invalid_credentials", "username or passphrase is incorrect")
	errInvalidTOTP     = errf(http.StatusUnauthorized, "invalid_totp", "the code is incorrect or was already used")
	errRateLimited     = errf(http.StatusTooManyRequests, "rate_limited", "too many attempts, try again in a minute")
	errDisabled        = errf(http.StatusForbidden, "account_disabled", "this account is disabled")
	errForbidden       = errf(http.StatusForbidden, "forbidden", "not allowed")
	errInternal        = errf(http.StatusInternalServerError, "internal", "internal server error")
	// errBusy answers a request that needed an Argon2 hash while every hashing slot was
	// taken (auth.ErrBusy). It is sent with a Retry-After header.
	errBusy = errf(http.StatusServiceUnavailable, "busy", "the server is busy, try again in a few seconds")
)

// busyRetryAfter is the Retry-After (seconds) sent with errBusy.
const busyRetryAfter = "3"

// handlerFunc is an HTTP handler that may return an error to be rendered as JSON.
type handlerFunc func(w http.ResponseWriter, r *http.Request) error

func (s *Server) wrap(fn handlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			var ae *apiError
			if errors.Is(err, auth.ErrBusy) {
				// Expected under load (or an attack on the hashing endpoints): not a server fault.
				s.log.Warn("hashing slots full", "method", r.Method, "path", r.URL.Path)
				w.Header().Set("Retry-After", busyRetryAfter)
				ae = errBusy
			} else if !errors.As(err, &ae) {
				s.log.Error("handler error", "method", r.Method, "path", r.URL.Path, "err", err)
				ae = errInternal
			} else if ae.status >= 500 {
				s.log.Error("handler error", "method", r.Method, "path", r.URL.Path, "err", ae, slog.Any("cause", errors.Unwrap(err)))
			}
			writeError(w, ae)
		}
	})
}

func writeError(w http.ResponseWriter, e *apiError) {
	body := map[string]any{"error": e.code, "message": e.msg}
	for k, v := range e.extra {
		body[k] = v
	}
	writeJSON(w, e.status, body)
}

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(v)
}

func ok(w http.ResponseWriter) error {
	return writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// okSeq answers a content write with the change-feed seq it took, so the writing device can move
// its sync cursor past its own change instead of downloading it again (SPEC §5.2).
func okSeq(w http.ResponseWriter, seq int64) error {
	return writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "seq": seq})
}

// decodeJSON reads a JSON request body (≤1 MB) into v.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errf(http.StatusRequestEntityTooLarge, "too_large", "request body too large")
		}
		if errors.Is(err, io.EOF) {
			return errf(http.StatusBadRequest, "bad_request", "request body required")
		}
		return errf(http.StatusBadRequest, "bad_request", "invalid JSON body")
	}
	if dec.More() {
		return errf(http.StatusBadRequest, "bad_request", "trailing data after JSON body")
	}
	return nil
}

func badRequest(format string, args ...any) *apiError {
	return errf(http.StatusBadRequest, "bad_request", format, args...)
}

// --- encoding helpers ---

// decodeB64 decodes standard base64 (padding optional).
func decodeB64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if strings.HasSuffix(s, "=") || len(s)%4 == 0 {
		if b, err := base64.StdEncoding.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
}

// decodeB64URL decodes base64url (padding optional), falling back to standard base64.
func decodeB64URL(s string) ([]byte, error) {
	if b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "=")); err == nil {
		return b, nil
	}
	return decodeB64(s)
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// key32 decodes a base64 32-byte client key (authKey, recoveryAuthKey).
func key32(field, s string) ([]byte, error) {
	b, err := decodeB64(s)
	if err != nil || len(b) != 32 {
		return nil, badRequest("%s must be 32 bytes, base64", field)
	}
	return b, nil
}

// --- timestamps ---

const timeLayout = "2006-01-02T15:04:05.000Z07:00"

func ts(t time.Time) string { return t.UTC().Format(timeLayout) }

func tsPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	v := ts(*t)
	return &v
}

// --- validation ---

var usernameRe = regexp.MustCompile(`^[a-z0-9._-]{3,32}$`)

func normalizeUsername(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func validUsername(s string) bool { return usernameRe.MatchString(s) }

// maxUsernameInput bounds the raw username accepted before normalisation;
// anything longer cannot be valid (32 chars plus surrounding whitespace).
const maxUsernameInput = 64

// invalidUsernameKey stands in for every malformed username, so client-chosen
// strings never become rate-limiter or failure-counter keys (SPEC §5.1).
const invalidUsernameKey = "!invalid"

// loginUsername normalises a username from a sign-in style request. Invalid or
// oversized input maps to invalidUsernameKey and valid=false.
func loginUsername(raw string) (username string, valid bool) {
	if len(raw) > maxUsernameInput {
		return invalidUsernameKey, false
	}
	u := normalizeUsername(raw)
	if !validUsername(u) {
		return invalidUsernameKey, false
	}
	return u, true
}

// plainText reports whether s is valid UTF-8 without control characters (C0, DEL,
// C1, including newlines and ESC) or bidirectional formatting characters.
func plainText(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || isBidiControl(r) {
			return false
		}
	}
	return true
}

// isBidiControl reports the Unicode bidirectional formatting characters, which
// can make displayed text read differently from what is stored.
func isBidiControl(r rune) bool {
	return r == 0x061C || r == 0x200E || r == 0x200F || (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// parseUUIDv4 validates a client-generated uuid v4 and returns it in canonical lowercase form.
func parseUUIDv4(field, s string) (string, error) {
	id, version, ok := uuid.Parse(s)
	if !ok || version != 4 {
		return "", badRequest("%s must be a uuid v4", field)
	}
	return id, nil
}

// pathUUID reads a uuid path value; malformed ids are reported as not found.
func pathUUID(r *http.Request, name string) (string, error) {
	id, _, ok := uuid.Parse(r.PathValue(name))
	if !ok {
		return "", errNotFound
	}
	return id, nil
}

// sealedJSON is the client ciphertext object shape {nonce, ct} (SPEC §3).
type sealedJSON struct {
	Nonce string `json:"nonce"`
	CT    string `json:"ct"`
}

// gcmNonceLen and gcmTagLen describe AES-GCM ciphertexts produced by the client.
const (
	gcmNonceLen = 12
	gcmTagLen   = 16
)

func (s *sealedJSON) decode(field string) (nonce, ct []byte, err error) {
	if s == nil {
		return nil, nil, badRequest("%s is required", field)
	}
	nonce, err = decodeB64(s.Nonce)
	if err != nil || len(nonce) != gcmNonceLen {
		return nil, nil, badRequest("%s.nonce must be 12 bytes, base64", field)
	}
	ct, err = decodeB64(s.CT)
	if err != nil || len(ct) < gcmTagLen {
		return nil, nil, badRequest("%s.ct must be AES-GCM ciphertext, base64", field)
	}
	return nonce, ct, nil
}

func encodeSealed(nonce, ct []byte) sealedJSON {
	return sealedJSON{Nonce: b64(nonce), CT: b64(ct)}
}

// maxWrappedKey bounds the size of a wrapped master key blob.
const maxWrappedKey = 4096

// wrappedKey validates a client-wrapped master key. The server treats it as
// opaque but requires either the ciphertext object shape {nonce, ct} or a single
// base64 string. It is stored and echoed back verbatim (compacted JSON).
func wrappedKey(field string, raw json.RawMessage) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", badRequest("%s is required", field)
	}
	if len(raw) > maxWrappedKey {
		return "", badRequest("%s is too large", field)
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		if b, err := decodeB64(str); err != nil || len(b) < gcmTagLen {
			return "", badRequest("%s must be base64 ciphertext", field)
		}
		out, _ := json.Marshal(str)
		return string(out), nil
	}
	var obj sealedJSON
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", badRequest("%s must be a {nonce, ct} object", field)
	}
	if _, _, err := obj.decode(field); err != nil {
		return "", err
	}
	out, _ := json.Marshal(obj)
	return string(out), nil
}

// kdfJSON is the passphrase KDF parameter object {salt, m, t, p}.
type kdfJSON struct {
	Salt string `json:"salt"`
	M    int    `json:"m"`
	T    int    `json:"t"`
	P    int    `json:"p"`
}

// Default client KDF parameters (SPEC §3); also used for fake prelogin responses.
const (
	kdfDefaultM = 65536
	kdfDefaultT = 3
	kdfDefaultP = 1

	kdfMaxM = 1 << 20 // 1 GiB
	kdfMaxT = 16
	kdfMaxP = 16
)

func (k *kdfJSON) validate() (salt []byte, err error) {
	if k == nil {
		return nil, badRequest("kdf is required")
	}
	salt, err = decodeB64(k.Salt)
	if err != nil || len(salt) < 16 || len(salt) > 64 {
		return nil, badRequest("kdf.salt must be 16-64 bytes, base64")
	}
	// Same bounds as the client enforces (SPEC §3): the floor is the spec's own
	// parameters, so no account can be created that a client would refuse to unlock.
	if k.M < kdfDefaultM || k.M > kdfMaxM {
		return nil, badRequest("kdf.m out of range")
	}
	if k.T < kdfDefaultT || k.T > kdfMaxT {
		return nil, badRequest("kdf.t out of range")
	}
	if k.P < kdfDefaultP || k.P > kdfMaxP {
		return nil, badRequest("kdf.p out of range")
	}
	return salt, nil
}
