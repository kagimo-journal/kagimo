package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func openWithUser(t *testing.T) (*Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	s := openTest(t)
	if err := s.CreateUser(ctx, newUser("u", "user")); err != nil {
		t.Fatal(err)
	}
	return s, ctx
}

func sealedN(n int) Sealed { return Sealed{Nonce: make([]byte, 12), CT: make([]byte, n)} }

// A change-feed page ends at the byte budget as well as at the entry count, never splits
// or skips an entry, and always carries at least one, however small the budget.
func TestChangesSinceByteBudget(t *testing.T) {
	s, ctx := openWithUser(t)
	// Each entry is 2×12 nonce + 76 + 100 = 200 bytes of ciphertext.
	const n = 7
	for i := 0; i < n; i++ {
		e := &Entry{ID: fmt.Sprintf("e%d", i), UserID: "u", Header: sealedN(76), Body: sealedN(100)}
		if err := s.CreateEntry(ctx, e, NoLimit); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name      string
		limit     int
		maxBytes  int64
		wantPages []int
	}{
		{"by count", 3, 1 << 20, []int{3, 3, 1}},
		{"by bytes", 100, 500, []int{2, 2, 2, 1}},
		{"exactly full pages", 100, 400, []int{2, 2, 2, 1}},
		{"whichever comes first", 2, 700, []int{2, 2, 2, 1}},
		{"budget smaller than one entry", 100, 10, []int{1, 1, 1, 1, 1, 1, 1}},
		{"everything fits", 100, 1 << 20, []int{7}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var (
				cursor int64
				pages  []int
				seen   []string
			)
			for {
				ch, err := s.ChangesSince(ctx, "u", cursor, tc.limit, tc.maxBytes)
				if err != nil {
					t.Fatal(err)
				}
				if len(pages) > n {
					t.Fatal("paging does not end")
				}
				pages = append(pages, len(ch.Entries))
				for _, e := range ch.Entries {
					seen = append(seen, e.ID)
				}
				if ch.Cursor <= cursor {
					t.Fatalf("cursor went from %d to %d", cursor, ch.Cursor)
				}
				cursor = ch.Cursor
				if !ch.More {
					break
				}
			}
			if fmt.Sprint(pages) != fmt.Sprint(tc.wantPages) {
				t.Fatalf("pages = %v, want %v", pages, tc.wantPages)
			}
			for i, id := range seen {
				if id != fmt.Sprintf("e%d", i) {
					t.Fatalf("entries out of order or repeated: %v", seen)
				}
			}
			if len(seen) != n || cursor != n {
				t.Fatalf("saw %d entries, cursor %d; want %d and %d", len(seen), cursor, n, n)
			}
		})
	}
}

// Tombstones are capped per user: past the cap the oldest go and the tombstone floor rises,
// so a create/delete loop cannot grow the database, deleting is never refused, and a device
// that needed a dropped tombstone is told to resync rather than left with a stale entry.
func TestTombstoneCap(t *testing.T) {
	defer func(n int) { MaxTombstones = n }(MaxTombstones)
	MaxTombstones = 3
	s, ctx := openWithUser(t)
	tombstones := func() (n int) {
		t.Helper()
		if err := s.DB().QueryRow(`SELECT COUNT(*) FROM tombstones WHERE user_id = 'u'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Create and delete in a loop: seqs 1,2 then 3,4 … so tombstone i has seq 2i.
	var cursors []int64 // cursors[i]: a device that synced right after deletion i
	for i := 1; i <= 6; i++ {
		id := fmt.Sprintf("e%d", i)
		if err := s.CreateEntry(ctx, &Entry{ID: id, UserID: "u", Header: sealedN(20), Body: sealedN(20)}, NoLimit); err != nil {
			t.Fatal(err)
		}
		seq, err := s.DeleteEntry(ctx, "u", id, time.Now())
		if err != nil {
			t.Fatalf("delete %d: %v", i, err)
		}
		if seq != int64(2*i) {
			t.Fatalf("delete %d took seq %d", i, seq)
		}
		cursors = append(cursors, seq)
		if got, want := tombstones(), min(i, MaxTombstones); got != want {
			t.Fatalf("after %d deletions: %d tombstones, want %d", i, got, want)
		}
	}
	// Tombstones 4, 5, 6 remain (seqs 8, 10, 12); 1-3 were dropped, the newest at seq 6.
	for i, cursor := range cursors {
		ch, err := s.ChangesSince(ctx, "u", cursor, 100, 1<<20)
		if deletion := i + 1; deletion < 3 {
			// It never saw deletion 3, whose tombstone is gone: it has to start over.
			if !errors.Is(err, ErrCursorExpired) {
				t.Fatalf("cursor after deletion %d: %v, want ErrCursorExpired", deletion, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("cursor after deletion %d: %v", i+1, err)
		}
		// Every deletion after its cursor is still in the feed.
		if got, want := len(ch.DeletedEntries), 6-(i+1); got != want {
			t.Fatalf("cursor after deletion %d: %d deletions in the feed, want %d", i+1, got, want)
		}
	}
	// A full resync is always possible, and pruning by age still works on what is left.
	if ch, err := s.ChangesSince(ctx, "u", 0, 100, 1<<20); err != nil || len(ch.Entries) != 0 || ch.Cursor != 12 {
		t.Fatalf("full resync: %+v %v", ch, err)
	}
	if n, err := s.PruneTombstones(ctx, time.Now().Add(time.Hour)); err != nil || n != 3 {
		t.Fatalf("prune: %d %v", n, err)
	}
	// Another user's tombstones are not touched by this user's cap.
	if err := s.CreateUser(ctx, newUser("v", "other")); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateEntry(ctx, &Entry{ID: "v1", UserID: "v", Header: sealedN(20), Body: sealedN(20)}, NoLimit); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteEntry(ctx, "v", "v1", time.Now()); err != nil {
		t.Fatal(err)
	}
	for i := 7; i <= 12; i++ {
		id := fmt.Sprintf("e%d", i)
		if err := s.CreateEntry(ctx, &Entry{ID: id, UserID: "u", Header: sealedN(20), Body: sealedN(20)}, NoLimit); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DeleteEntry(ctx, "u", id, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	var others int
	if err := s.DB().QueryRow(`SELECT COUNT(*) FROM tombstones WHERE user_id = 'v'`).Scan(&others); err != nil || others != 1 {
		t.Fatalf("other user's tombstones: %d %v", others, err)
	}
}

func TestCredentialCap(t *testing.T) {
	s, ctx := openWithUser(t)
	add := func(user string, i int) error {
		return s.CreateCredential(ctx, &Credential{ID: fmt.Sprintf("%s-c%d", user, i), UserID: user,
			CredentialID: []byte(fmt.Sprintf("%s-cred-%d", user, i)), PublicKey: []byte{1}, Name: "Key", CreatedAt: time.Now()})
	}
	for i := 0; i < MaxCredentials; i++ {
		if err := add("u", i); err != nil {
			t.Fatalf("passkey %d: %v", i, err)
		}
	}
	if err := add("u", MaxCredentials); !errors.Is(err, ErrTooManyCredentials) {
		t.Fatalf("passkey past the cap: %v, want ErrTooManyCredentials", err)
	}
	if n, err := s.CountCredentials(ctx, "u"); err != nil || n != MaxCredentials {
		t.Fatalf("count = %d %v", n, err)
	}
	// Removing one makes room again, and the cap is per user.
	if err := s.DeleteCredential(ctx, "u", "u-c0"); err != nil {
		t.Fatal(err)
	}
	if err := add("u", MaxCredentials); err != nil {
		t.Fatalf("after removing one: %v", err)
	}
	if err := s.CreateUser(ctx, newUser("v", "other")); err != nil {
		t.Fatal(err)
	}
	if err := add("v", 0); err != nil {
		t.Fatalf("other user: %v", err)
	}
}
