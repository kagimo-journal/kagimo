package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// together runs fn n times at once and returns each call's error.
func together(n int, fn func(i int) error) []error {
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = fn(i)
		}()
	}
	wg.Wait()
	return errs
}

// Writes arriving at once for the same user each take their own change-feed seq, with none
// lost or repeated, and deletes racing updates of the same entries neither deadlock nor fail.
func TestConcurrentWritesTakeDistinctSeqs(t *testing.T) {
	s, ctx := openWithUser(t)
	const n = 24
	now := time.Now()
	for _, err := range together(n, func(i int) error {
		return s.CreateEntry(ctx, &Entry{ID: fmt.Sprintf("e%d", i), UserID: "u", CreatedAt: now, UpdatedAt: now,
			Header: sealedN(8), Body: sealedN(8)}, 1<<30)
	}) {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, err := range together(2*n, func(i int) error {
		id := fmt.Sprintf("e%d", i/2)
		if i%2 == 0 {
			_, _, _, err := s.UpdateEntry(ctx, "u", id, 1, sealedN(8), sealedN(16), now, 1<<30)
			if errors.Is(err, ErrNotFound) { // the delete got there first
				return nil
			}
			return err
		}
		_, err := s.DeleteEntry(ctx, "u", id, now)
		return err
	}) {
		if err != nil {
			t.Fatal(err)
		}
	}
	ch, err := s.ChangesSince(ctx, "u", 0, 1000, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	var head, tombs, distinct int64
	if err := s.DB().QueryRow(`SELECT sync_seq FROM users WHERE id = 'u'`).Scan(&head); err != nil {
		t.Fatal(err)
	}
	if err := s.DB().QueryRow(`SELECT COUNT(*), COUNT(DISTINCT seq) FROM tombstones WHERE user_id = 'u'`).Scan(&tombs, &distinct); err != nil {
		t.Fatal(err)
	}
	if len(ch.Entries) != 0 || tombs != n || distinct != n || head < 2*n || head > 3*n || ch.Cursor != head {
		t.Fatalf("entries=%d tombstones=%d (distinct seqs %d) head=%d cursor=%d", len(ch.Entries), tombs, distinct, head, ch.Cursor)
	}
}

// Of several sign-ups landing on an empty database at once, exactly one becomes the admin.
func TestConcurrentFirstSignupsMakeOneAdmin(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	users := make([]*User, 8)
	for _, err := range together(len(users), func(i int) error {
		users[i] = newUser(fmt.Sprintf("u%d", i), fmt.Sprintf("user%d", i))
		return s.CreateUser(ctx, users[i])
	}) {
		if err != nil {
			t.Fatal(err)
		}
	}
	admins := 0
	for _, u := range users {
		if u.IsAdmin {
			admins++
		}
	}
	if admins != 1 {
		t.Fatalf("%d admins", admins)
	}
}

// A recovery token or an invite used from several requests at once is spent exactly once.
func TestConcurrentSingleUse(t *testing.T) {
	s, ctx := openWithUser(t)
	now := time.Now()
	token := []byte("token-hash")
	if err := s.CreateRecoveryToken(ctx, token, "u", now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	won := 0
	for _, err := range together(8, func(int) error {
		_, err := s.ConsumeRecoveryToken(ctx, token, now)
		return err
	}) {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, ErrNotFound):
			t.Fatal(err)
		}
	}
	if won != 1 {
		t.Fatalf("recovery token consumed %d times", won)
	}

	if err := s.CreateInvite(ctx, &Invite{ID: "i", CreatedAt: now}, "ABCD-EFGH-JKMN-PQRS"); err != nil {
		t.Fatal(err)
	}
	won = 0
	for _, err := range together(8, func(i int) error {
		return s.CreateUserWithInvite(ctx, newUser(fmt.Sprintf("g%d", i), fmt.Sprintf("guest%d", i)), InviteCodeHash("abcd-efgh-jkmn-pqrs"))
	}) {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, ErrInvalidInvite):
			t.Fatal(err)
		}
	}
	if n, _ := s.CountUsers(ctx); won != 1 || n != 2 {
		t.Fatalf("invite redeemed %d times, %d users", won, n)
	}

	// Wrong TOTP codes arriving together are each counted.
	for _, err := range together(8, func(int) error {
		_, err := s.UpdateTOTPFailures(ctx, "u", func(f TOTPFailures) TOTPFailures { f.Count++; return f })
		return err
	}) {
		if err != nil {
			t.Fatal(err)
		}
	}
	if u, _ := s.UserByID(ctx, "u"); u.TOTPFailures.Count != 8 {
		t.Fatalf("counted %d of 8 wrong codes", u.TOTPFailures.Count)
	}
}
