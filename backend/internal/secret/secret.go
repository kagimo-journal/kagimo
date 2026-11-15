// Package secret manages the server's secret.key: 32 random bytes from which
// purpose-specific subkeys are derived (TOTP-at-rest encryption, fake KDF salts,
// device-cookie MACs).
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// KeySize is the length of secret.key.
const KeySize = 32

const (
	infoTOTP     = "journal/server/totp-at-rest/v1"
	infoPrelogin = "journal/server/prelogin-salt/v1"
	infoDevice   = "journal/server/device-cookie/v1"
)

// Keyring holds subkeys derived from secret.key.
type Keyring struct {
	aead        cipher.AEAD
	preloginKey []byte
	deviceKey   []byte
}

// LoadOrCreate reads the key file at path, creating it (0600) with fresh random
// bytes if it does not exist.
func LoadOrCreate(path string) (*Keyring, error) {
	key, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		key = make([]byte, KeySize)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, fmt.Errorf("create %s: %w", path, err)
		}
		if _, err := f.Write(key); err != nil {
			f.Close()
			return nil, err
		}
		if err := f.Close(); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if len(key) != KeySize {
		return nil, fmt.Errorf("%s: expected %d bytes, got %d", path, KeySize, len(key))
	}
	return New(key)
}

// New derives a keyring from a 32-byte master secret.
func New(key []byte) (*Keyring, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("secret key must be %d bytes", KeySize)
	}
	encKey, err := hkdf.Key(sha256.New, key, nil, infoTOTP, 32)
	if err != nil {
		return nil, err
	}
	macKey, err := hkdf.Key(sha256.New, key, nil, infoPrelogin, 32)
	if err != nil {
		return nil, err
	}
	devKey, err := hkdf.Key(sha256.New, key, nil, infoDevice, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Keyring{aead: aead, preloginKey: macKey, deviceKey: devKey}, nil
}

// Seal encrypts plaintext with AES-256-GCM, returning nonce||ciphertext.
func (k *Keyring) Seal(plaintext, aad []byte) ([]byte, error) {
	nonce := make([]byte, k.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return k.aead.Seal(nonce, nonce, plaintext, aad), nil
}

// Open decrypts the output of Seal.
func (k *Keyring) Open(sealed, aad []byte) ([]byte, error) {
	ns := k.aead.NonceSize()
	if len(sealed) < ns+k.aead.Overhead() {
		return nil, errors.New("secret: ciphertext too short")
	}
	return k.aead.Open(nil, sealed[:ns], sealed[ns:], aad)
}

// FakeSalt returns a deterministic 16-byte salt for an unknown username, so that
// prelogin responses do not reveal whether an account exists.
func (k *Keyring) FakeSalt(username string) []byte {
	m := hmac.New(sha256.New, k.preloginKey)
	m.Write([]byte(username))
	return m.Sum(nil)[:16]
}

// DeviceMAC returns HMAC-SHA256 over msg with the device-cookie subkey. It
// authenticates the long-lived "recognised device" cookie (SPEC §5.1).
func (k *Keyring) DeviceMAC(msg []byte) []byte {
	m := hmac.New(sha256.New, k.deviceKey)
	m.Write(msg)
	return m.Sum(nil)
}
