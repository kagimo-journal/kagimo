package passkey

import (
	"fmt"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

func stub() webauthn.SessionData {
	return webauthn.SessionData{Challenge: "stub-challenge-value-0123456789abcdef"}
}

func put(t *testing.T, cs *Challenges, owner string) string {
	t.Helper()
	id, err := cs.Put(KindLogin, "", owner, stub())
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func taken(cs *Challenges, id string) bool {
	_, err := cs.Take(id, KindLogin, "")
	return err == nil
}

// A full pool makes room by dropping the oldest challenge; it never refuses a new one.
func TestChallengesFullPoolEvictsOldest(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	cs := NewChallenges(func() time.Time { return now })
	cs.max = 4
	var ids []string
	for i := 0; i < cs.max; i++ {
		ids = append(ids, put(t, cs, fmt.Sprintf("ip|192.0.2.%d", i)))
		now = now.Add(time.Second)
	}
	newest := put(t, cs, "ip|198.51.100.1")
	if cs.Len() != cs.max {
		t.Fatalf("pool holds %d, want %d", cs.Len(), cs.max)
	}
	if taken(cs, ids[0]) {
		t.Fatal("the oldest challenge survived a full pool")
	}
	for _, id := range append(ids[1:], newest) {
		if !taken(cs, id) {
			t.Fatalf("challenge %s was dropped, though it was not the oldest", id)
		}
	}
	if cs.Len() != 0 || len(cs.byOwner) != 0 || cs.order.Len() != 0 {
		t.Fatalf("leftovers: %d items, %d owners, %d in order", cs.Len(), len(cs.byOwner), cs.order.Len())
	}

	// Expired challenges go before live ones do.
	stale := put(t, cs, "ip|192.0.2.1")
	now = now.Add(ChallengeTTL)
	var live []string
	for i := 0; i < cs.max; i++ {
		live = append(live, put(t, cs, fmt.Sprintf("ip|192.0.2.%d", 10+i)))
	}
	if taken(cs, stale) {
		t.Fatal("expired challenge still usable")
	}
	for _, id := range live {
		if !taken(cs, id) {
			t.Fatal("a live challenge was dropped while an expired one could have been")
		}
	}
}

// One owner can hold MaxPerOwner challenges; beginning more drops that owner's oldest and
// nobody else's.
func TestChallengesPerOwnerCap(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	cs := NewChallenges(func() time.Time { return now })
	victim := put(t, cs, "ip|192.0.2.1")
	account := put(t, cs, "user|u1")

	var flood []string
	for i := 0; i < MaxPerOwner+3; i++ {
		flood = append(flood, put(t, cs, "ip|203.0.113.9"))
	}
	if want := MaxPerOwner + 2; cs.Len() != want {
		t.Fatalf("pool holds %d, want %d", cs.Len(), want)
	}
	for i, id := range flood {
		if got, want := taken(cs, id), i >= 3; got != want {
			t.Fatalf("flooder's challenge %d: usable = %v, want %v", i, got, want)
		}
	}
	if !taken(cs, victim) || !taken(cs, account) {
		t.Fatal("another owner's challenge was dropped")
	}

	// Finishing (or abandoning to expiry) gives the allowance back.
	for i := 0; i < MaxPerOwner; i++ {
		put(t, cs, "ip|203.0.113.9")
	}
	now = now.Add(ChallengeTTL)
	cs.Prune()
	if cs.Len() != 0 || len(cs.byOwner) != 0 {
		t.Fatalf("prune left %d items, %d owners", cs.Len(), len(cs.byOwner))
	}
	fresh := put(t, cs, "ip|203.0.113.9")
	if !taken(cs, fresh) {
		t.Fatal("challenge after prune not usable")
	}
}
