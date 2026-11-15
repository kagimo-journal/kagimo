package admin

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"journal/internal/store"
)

func TestAdminCLI(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := store.Open(ctx, filepath.Join(dir, "journal.db"))
	if err != nil {
		t.Fatal(err)
	}
	for i, name := range []string{"root", "bob"} {
		u := &store.User{ID: name, Username: name, WebAuthnHandle: []byte{byte(i)}, KDF: store.KDF{Salt: make([]byte, 16), M: 65536, T: 3, P: 1},
			AuthHash: "h", RecoveryHash: "r", WrappedMKPass: `"x"`, WrappedMKRecovery: `"y"`, CreatedAt: time.Now()}
		if err := s.CreateUser(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	s.Close()

	run := func(args ...string) (string, error) {
		var out, errOut bytes.Buffer
		err := Run(ctx, args, dir, &out, &errOut)
		return out.String(), err
	}
	cases := []struct {
		args    []string
		wantOut string
		wantErr string
	}{
		{[]string{"list"}, "bob", ""},
		{[]string{"approve", "bob"}, "", "unknown command"},
		{[]string{"promote", "BOB"}, "is now an admin", ""},
		{[]string{"disable", "bob"}, "disabled bob", ""},
		{[]string{"disable", "nobody"}, "", "no such user"},
		{[]string{"explode"}, "", "unknown command"},
		{[]string{}, "", "missing command"},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			out, err := run(tc.args...)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil || !strings.Contains(out, tc.wantOut) {
				t.Fatalf("out %q err %v", out, err)
			}
		})
	}
	s, _ = store.Open(ctx, filepath.Join(dir, "journal.db"))
	defer s.Close()
	u, _ := s.UserByUsername(ctx, "bob")
	if u.Status != store.StatusDisabled || !u.IsAdmin {
		t.Fatalf("final state: %+v", u)
	}
}

// Notes (and usernames) written before signup rejected control characters must
// not reach the terminal raw.
func TestAdminListSanitises(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := store.Open(ctx, filepath.Join(dir, "journal.db"))
	if err != nil {
		t.Fatal(err)
	}
	u := &store.User{ID: "e", Username: "eve\x1b[2J", Note: "hi \x1b]0;pwned\x07 \u202eevil\x9b", WebAuthnHandle: []byte{1},
		KDF: store.KDF{Salt: make([]byte, 16), M: 65536, T: 3, P: 1}, AuthHash: "h", RecoveryHash: "r",
		WrappedMKPass: `"x"`, WrappedMKRecovery: `"y"`, CreatedAt: time.Now()}
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	s.Close()
	var out, errOut bytes.Buffer
	if err := Run(ctx, []string{"list"}, dir, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"\x1b", "\x07", "\u202e", "\u009b"} {
		if strings.Contains(out.String(), bad) {
			t.Fatalf("list output contains %q: %q", bad, out.String())
		}
	}
	if !strings.Contains(out.String(), "pwned") {
		t.Fatalf("note text missing: %q", out.String())
	}
}
