// Package auth contains server-side authentication primitives: hashing of
// client-derived auth keys, session tokens, TOTP and rate limiting.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters for hashing authKey / recoveryAuthKey server-side (SPEC §3).
const (
	hashMemory  = 19456
	hashTime    = 2
	hashThreads = 1
	hashSaltLen = 16
	hashKeyLen  = 32
)

var b64 = base64.RawStdEncoding

// Every hash allocates hashMemory (19 MiB), and the endpoints that hash are reachable
// without a session, so the number computed at once is capped for the whole process:
// hashSlots of them fit comfortably in a 256 MB machine next to everything else. A
// caller that finds every slot taken waits up to hashWait, then gets ErrBusy.
const (
	hashSlots = 3
	hashWait  = 3 * time.Second
)

// ErrBusy is returned by HashSecret, VerifySecret and BurnVerify when no hashing slot
// came free in time. Nothing was computed; the caller should ask the client to retry.
var ErrBusy = errors.New("auth: too many hashes in progress")

var (
	hashSem = make(chan struct{}, hashSlots)
	// hashWaitFor is hashWait; tests shorten it.
	hashWaitFor = hashWait
	// hashCount counts the slots handed out, i.e. the Argon2 computations started.
	hashCount atomic.Int64
)

// HashCount returns how many Argon2 computations have been started (for tests and
// diagnostics).
func HashCount() int64 { return hashCount.Load() }

// acquireHash takes a hashing slot, waiting up to hashWaitFor. It gives up early, with
// the context's error, if ctx ends first (the client went away).
func acquireHash(ctx context.Context) error {
	select {
	case hashSem <- struct{}{}:
		hashCount.Add(1)
		return nil
	default:
	}
	t := time.NewTimer(hashWaitFor)
	defer t.Stop()
	select {
	case hashSem <- struct{}{}:
		hashCount.Add(1)
		return nil
	case <-t.C:
		return ErrBusy
	case <-ctx.Done():
		return ctx.Err()
	}
}

func releaseHash() { <-hashSem }

// HashSecret hashes a client-derived secret with argon2id and returns a PHC string.
// ErrBusy if too many hashes are already being computed.
func HashSecret(ctx context.Context, secret []byte) (string, error) {
	if err := acquireHash(ctx); err != nil {
		return "", err
	}
	defer releaseHash()
	return hashSecret(secret)
}

func hashSecret(secret []byte) (string, error) {
	salt := make([]byte, hashSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum := argon2.IDKey(secret, salt, hashTime, hashMemory, hashThreads, hashKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, hashMemory, hashTime, hashThreads, b64.EncodeToString(salt), b64.EncodeToString(sum)), nil
}

// VerifySecret checks secret against a PHC string produced by HashSecret, in constant time.
// ErrBusy if too many hashes are already being computed.
func VerifySecret(ctx context.Context, encoded string, secret []byte) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("auth: malformed hash")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errors.New("auth: unsupported argon2 version")
	}
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, errors.New("auth: malformed hash params")
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, errors.New("auth: malformed salt")
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, errors.New("auth: malformed hash")
	}
	if err := acquireHash(ctx); err != nil {
		return false, err
	}
	defer releaseHash()
	got := argon2.IDKey(secret, salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified against when a username does not exist, so that the
// response time does not reveal account existence.
var dummyHash = func() string {
	h, err := hashSecret([]byte("journal/dummy"))
	if err != nil {
		panic(err)
	}
	return h
}()

// BurnVerify spends the same CPU/memory as a real verification and always fails. Like a
// real verification it returns ErrBusy when no hashing slot came free, so a caller that
// passes the error on answers the same for accounts that exist and ones that don't.
func BurnVerify(ctx context.Context, secret []byte) error {
	_, err := VerifySecret(ctx, dummyHash, secret)
	return err
}

// NewToken returns a random URL-safe token and its SHA-256 hash (what gets stored).
func NewToken() (token string, hash []byte, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, HashToken(token), nil
}

// HashToken hashes a token for storage/lookup.
func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
