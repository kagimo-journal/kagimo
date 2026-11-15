package secret

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret.key")
	k1, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 || st.Size() != KeySize {
		t.Fatalf("mode %v size %d", st.Mode().Perm(), st.Size())
	}
	k2, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(k1.FakeSalt("bob"), k2.FakeSalt("bob")) {
		t.Fatal("fake salt must be stable across restarts")
	}
	sealed, err := k1.Seal([]byte("JBSWY3DPEHPK3PXP"), []byte("aad"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := k2.Open(sealed, []byte("aad")); err != nil || string(got) != "JBSWY3DPEHPK3PXP" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := k2.Open(sealed, []byte("other")); err == nil {
		t.Fatal("AAD must be bound")
	}
	bad := filepath.Join(t.TempDir(), "short.key")
	os.WriteFile(bad, []byte("short"), 0o600)
	if _, err := LoadOrCreate(bad); err == nil {
		t.Fatal("short key accepted")
	}
}

func TestFakeSalt(t *testing.T) {
	k, _ := New(bytes.Repeat([]byte{7}, KeySize))
	if len(k.FakeSalt("a")) != 16 || bytes.Equal(k.FakeSalt("a"), k.FakeSalt("b")) {
		t.Fatal("fake salts must be 16 bytes and per-username")
	}
	other, _ := New(bytes.Repeat([]byte{8}, KeySize))
	if bytes.Equal(k.FakeSalt("a"), other.FakeSalt("a")) {
		t.Fatal("fake salts must depend on the server secret")
	}
}

func TestDeviceMACIndependentOfOtherKeys(t *testing.T) {
	k, err := New(bytes.Repeat([]byte{7}, KeySize))
	if err != nil {
		t.Fatal(err)
	}
	a, b := k.DeviceMAC([]byte("x")), k.DeviceMAC([]byte("y"))
	if len(a) != 32 || bytes.Equal(a, b) || bytes.Equal(a[:16], k.FakeSalt("x")) {
		t.Fatal("device MAC must be a distinct 32-byte HMAC")
	}
}
