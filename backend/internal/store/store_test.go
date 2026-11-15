package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// openTest opens an empty database for the test: SQLite, or Postgres when
// JOURNAL_TEST_DATABASE_URL is set.
func openTest(t *testing.T) *Store {
	t.Helper()
	s, cleanup, err := OpenForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	return s
}

// sqliteOnly skips a test of SQLite's own behaviour when the tests run against Postgres.
func sqliteOnly(t *testing.T) {
	t.Helper()
	if os.Getenv(TestDatabaseURLEnv) != "" {
		t.Skip("SQLite only")
	}
}

// Both dialects end at the same migration, and applying them again changes nothing.
func TestMigrationsReapply(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	latest := func() (v int) {
		t.Helper()
		if err := s.DB().QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	if err := s.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	for _, d := range []dialect{sqlite, postgres} {
		migs, err := loadMigrations(d)
		if err != nil {
			t.Fatal(err)
		}
		if want := migs[len(migs)-1].version; latest() != want {
			t.Fatalf("%s: database is at migration %d, the %s folder ends at %d", s.Dialect(), latest(), d, want)
		}
	}
}

func TestOpenMigratesIdempotently(t *testing.T) {
	sqliteOnly(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "journal.db")
	for i := 0; i < 2; i++ {
		s, err := Open(ctx, path)
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		var n int
		if err := s.DB().QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil || n != 7 {
			t.Fatalf("migrations = %d, %v", n, err)
		}
		var mode string
		s.DB().QueryRow(`PRAGMA journal_mode`).Scan(&mode)
		var fk int
		s.DB().QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
		if mode != "wal" || fk != 1 {
			t.Fatalf("journal_mode=%s foreign_keys=%d", mode, fk)
		}
		s.Close()
	}
}

func newUser(id, name string) *User {
	return &User{
		ID: id, Username: name, WebAuthnHandle: []byte(id), KDF: KDF{Salt: make([]byte, 16), M: 65536, T: 3, P: 1},
		AuthHash: "h", RecoveryHash: "r", WrappedMKPass: `"x"`, WrappedMKRecovery: `"y"`, CreatedAt: time.Now(),
	}
}

func TestBootstrapAndCascade(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	first, second := newUser("u1", "alice"), newUser("u2", "bob")
	if err := s.CreateUser(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateUser(ctx, second); err != nil {
		t.Fatal(err)
	}
	if !first.IsAdmin || first.Status != StatusActive || second.IsAdmin || second.Status != StatusActive {
		t.Fatalf("bootstrap: %+v %+v", first, second)
	}
	if err := s.CreateUser(ctx, newUser("u3", "ALICE")); err != ErrConflict {
		t.Fatalf("case-insensitive uniqueness: %v", err)
	}
	now := time.Now()
	e := &Entry{ID: "e1", UserID: "u2", CreatedAt: now, UpdatedAt: now, Header: Sealed{[]byte("n"), []byte("c")}, Body: Sealed{[]byte("n"), []byte("c")}}
	if err := s.CreateEntry(ctx, e, NoLimit); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateBlob(ctx, &Blob{ID: "b1", UserID: "u2", EntryID: "e1", Nonce: []byte("n"), Data: []byte("d"), Size: 1, CreatedAt: now}, NoLimit); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, &Session{IDHash: []byte("h"), UserID: "u2", State: SessionFull, CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastSeenAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(ctx, "u2"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"entries", "blobs", "sessions"} {
		var n int
		s.DB().QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n)
		if n != 0 {
			t.Fatalf("%s not cascaded: %d rows", table, n)
		}
	}
}

func TestDeleteOrphanBlobs(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for _, u := range []*User{newUser("u1", "alice"), newUser("u2", "bob")} {
		if err := s.CreateUser(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	old := now.Add(-48 * time.Hour)
	sealed := Sealed{[]byte("n"), []byte("c")}
	if err := s.CreateEntry(ctx, &Entry{ID: "e1", UserID: "u1", CreatedAt: now, UpdatedAt: now, Header: sealed, Body: sealed}, NoLimit); err != nil {
		t.Fatal(err)
	}
	blobs := []struct {
		id, user, entry string
		at              time.Time
		keep            bool
	}{
		{"attached", "u1", "e1", old, true},
		{"no-entry", "u1", "", old, false},
		{"missing-entry", "u1", "gone", old, false},
		{"foreign-entry", "u2", "e1", old, false}, // e1 belongs to u1, not u2
		{"recent-orphan", "u1", "gone", now, true},
	}
	for _, b := range blobs {
		if err := s.CreateBlob(ctx, &Blob{ID: b.id, UserID: b.user, EntryID: b.entry, Nonce: []byte("n"), Data: []byte("d"), Size: 1, CreatedAt: b.at}, NoLimit); err != nil {
			t.Fatal(err)
		}
	}
	n, err := s.DeleteOrphanBlobs(ctx, now.Add(-24*time.Hour))
	if err != nil || n != 3 {
		t.Fatalf("deleted %d, %v; want 3", n, err)
	}
	for _, b := range blobs {
		_, err := s.GetBlob(ctx, b.user, b.id)
		if (err == nil) != b.keep {
			t.Errorf("blob %s: keep=%v, err=%v", b.id, b.keep, err)
		}
	}
}

func TestSessionAuthAt(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if err := s.CreateUser(ctx, newUser("u1", "alice")); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(time.Now().UnixMilli()).UTC()
	if err := s.CreateSession(ctx, &Session{IDHash: []byte("h"), UserID: "u1", State: SessionMFAPending, CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastSeenAt: now}); err != nil {
		t.Fatal(err)
	}
	sess, err := s.SessionByHash(ctx, []byte("h"), now)
	if err != nil || !sess.AuthAt.IsZero() {
		t.Fatalf("new session AuthAt = %v, %v", sess, err)
	}
	later := now.Add(time.Minute)
	if err := s.MarkSessionAuthenticated(ctx, []byte("h"), later); err != nil {
		t.Fatal(err)
	}
	if sess, _ = s.SessionByHash(ctx, []byte("h"), now); !sess.AuthAt.Equal(later) {
		t.Fatalf("AuthAt = %v, want %v", sess.AuthAt, later)
	}
	if err := s.MarkSessionAuthenticated(ctx, []byte("nope"), later); err != ErrNotFound {
		t.Fatalf("unknown session: %v", err)
	}
}
