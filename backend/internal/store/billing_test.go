package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

// A database created before billing: existing accounts are grandfathered (comped);
// accounts created afterwards are not.
func TestBillingMigrationGrandfathers(t *testing.T) {
	sqliteOnly(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "journal.db")
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	migs, err := loadMigrations(sqlite)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migs {
		if m.version >= 4 {
			break
		}
		if _, err := raw.Exec(m.sql); err != nil {
			t.Fatal(err)
		}
		raw.Exec(`INSERT INTO schema_migrations VALUES (?, ?, 0)`, m.version, m.name)
	}
	for _, id := range []string{"old1", "old2"} {
		if _, err := raw.Exec(`INSERT INTO users (id, username, status, webauthn_handle, kdf_salt, kdf_m, kdf_t, kdf_p,
			auth_hash, recovery_hash, wrapped_mk_pass, wrapped_mk_recovery, created_at)
			VALUES (?, ?, 'active', ?, x'00', 1, 1, 1, '', '', '', '', 0)`, id, id, []byte(id)); err != nil {
			t.Fatal(err)
		}
	}
	raw.Close()

	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	u1, _ := s.UserByID(ctx, "old1")
	u2, _ := s.UserByID(ctx, "old2")
	if !u1.Comped || !u2.Comped {
		t.Fatalf("old1 comped=%v old2 comped=%v", u1.Comped, u2.Comped)
	}
	nu := newUser("new", "newbie")
	if err := s.CreateUser(ctx, nu); err != nil {
		t.Fatal(err)
	}
	got, _ := s.UserByID(ctx, "new")
	if got.Comped || got.Status != StatusActive || got.IsAdmin {
		t.Fatalf("new user = comped %v status %s admin %v", got.Comped, got.Status, got.IsAdmin)
	}
}

// The storage limit refuses writes that grow the account past it, and nothing else.
func TestStorageLimit(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if err := s.CreateUser(ctx, newUser("u", "user")); err != nil {
		t.Fatal(err)
	}
	sealed := func(n int) Sealed { return Sealed{Nonce: make([]byte, 12), CT: make([]byte, n)} }
	usage := func() int64 {
		t.Helper()
		n, err := s.UsageBytes(ctx, "u")
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	const limit = 1000

	// 2×12 nonce + 100 + 300 = 424 bytes.
	e := &Entry{ID: "e1", UserID: "u", Header: sealed(100), Body: sealed(300)}
	if err := s.CreateEntry(ctx, e, limit); err != nil {
		t.Fatal(err)
	}
	if got := usage(); got != 424 {
		t.Fatalf("usage = %d, want 424", got)
	}
	// Another 424 fits (848); a third doesn't, and leaves nothing behind.
	e2 := &Entry{ID: "e2", UserID: "u", Header: sealed(100), Body: sealed(300)}
	if err := s.CreateEntry(ctx, e2, limit); err != nil {
		t.Fatal(err)
	}
	e3 := &Entry{ID: "e3", UserID: "u", Header: sealed(100), Body: sealed(300)}
	if err := s.CreateEntry(ctx, e3, limit); err != ErrQuota {
		t.Fatalf("third entry: %v, want ErrQuota", err)
	}
	if got := usage(); got != 848 {
		t.Fatalf("usage after refused write = %d, want 848", got)
	}
	// Photos (only ever stored before uploads stopped) don't count; settings do.
	if err := s.CreateBlob(ctx, &Blob{ID: "b1", UserID: "u", Nonce: make([]byte, 12), Data: make([]byte, 200), Size: 200}, limit); err != nil {
		t.Fatalf("blob: %v, want it not to count", err)
	}
	if got := usage(); got != 848 {
		t.Fatalf("usage with a photo = %d, want 848", got)
	}
	if _, err := s.PutSettings(ctx, "u", sealed(200), time.Now(), limit); err != ErrQuota {
		t.Fatalf("settings: %v, want ErrQuota", err)
	}
	// Growing an entry past the limit is refused; shrinking one is fine.
	if _, _, _, err := s.UpdateEntry(ctx, "u", "e1", 1, sealed(100), sealed(500), time.Now(), limit); err != ErrQuota {
		t.Fatalf("growing update: %v, want ErrQuota", err)
	}
	if _, _, _, err := s.UpdateEntry(ctx, "u", "e1", 1, sealed(10), sealed(10), time.Now(), limit); err != nil {
		t.Fatalf("shrinking update: %v", err)
	}
	// Over the limit (e.g. after a subscription lapsed), a write that keeps the size is allowed.
	if _, _, _, err := s.UpdateEntry(ctx, "u", "e2", 1, sealed(100), sealed(300), time.Now(), 10); err != nil {
		t.Fatalf("same-size update over the limit: %v", err)
	}
	// A stale version is still a conflict, not a quota error.
	if _, _, cur, err := s.UpdateEntry(ctx, "u", "e2", 1, sealed(1), sealed(1), time.Now(), limit); err != ErrConflict || cur != 2 {
		t.Fatalf("stale update: %v cur=%d", err, cur)
	}
	// No limit.
	if err := s.CreateEntry(ctx, e3, NoLimit); err != nil {
		t.Fatalf("unlimited: %v", err)
	}
}
