package auth

import (
	"context"
	"testing"
	"time"
)

func TestHashSecret(t *testing.T) {
	h, err := HashSecret(context.Background(), []byte("secret-key-material"))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		hash   string
		secret string
		want   bool
		err    bool
	}{
		{"match", h, "secret-key-material", true, false},
		{"mismatch", h, "other", false, false},
		{"malformed", "$bcrypt$xyz", "secret-key-material", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := VerifySecret(context.Background(), tc.hash, []byte(tc.secret))
			if got != tc.want || (err != nil) != tc.err {
				t.Fatalf("got %v, %v", got, err)
			}
		})
	}
	h2, _ := HashSecret(context.Background(), []byte("secret-key-material"))
	if h == h2 {
		t.Fatal("hashes must be salted")
	}
}

func TestMatchTOTP(t *testing.T) {
	secret, _, err := NewTOTPSecret("Journal", "alice")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_015, 0)
	step := TOTPStep(now)
	code := func(d int64) string {
		c, err := TOTPCode(secret, time.Unix((step+d)*TOTPPeriod, 0))
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	cases := []struct {
		name     string
		code     string
		lastStep int64
		wantOK   bool
		wantStep int64
	}{
		{"current", code(0), 0, true, step},
		{"previous step", code(-1), 0, true, step - 1},
		{"next step", code(1), 0, true, step + 1},
		{"two steps back", code(-2), 0, false, 0},
		{"replay of used step", code(0), step, false, 0},
		{"older than used", code(-1), step, false, 0},
		{"newer than used", code(1), step, true, step + 1},
		{"non-digit", "12a456", 0, false, 0},
		{"wrong length", "12345", 0, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := MatchTOTP(secret, tc.code, now, tc.lastStep)
			if ok != tc.wantOK || got != tc.wantStep {
				t.Fatalf("got (%d,%v), want (%d,%v)", got, ok, tc.wantStep, tc.wantOK)
			}
		})
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter(3, time.Minute, func() time.Time { return now })
	for i := 0; i < 3; i++ {
		if !l.Allow("k") {
			t.Fatalf("event %d denied", i)
		}
	}
	if l.Allow("k") {
		t.Fatal("4th event allowed")
	}
	if !l.Allow("other") {
		t.Fatal("independent key denied")
	}
	now = now.Add(20 * time.Second) // one token refills
	if !l.Allow("k") || l.Allow("k") {
		t.Fatal("refill incorrect")
	}
}

func TestToken(t *testing.T) {
	tok, hash, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) < 40 || string(HashToken(tok)) != string(hash) {
		t.Fatal("token/hash mismatch")
	}
}

func TestLimiterExhausted(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter(2, time.Minute, func() time.Time { return now })
	if l.Exhausted("k") {
		t.Fatal("unknown key exhausted")
	}
	l.Allow("k")
	if l.Exhausted("k") {
		t.Fatal("exhausted after one of two events")
	}
	l.Allow("k")
	if !l.Exhausted("k") {
		t.Fatal("not exhausted after two events")
	}
	now = now.Add(30 * time.Second)
	if l.Exhausted("k") {
		t.Fatal("no refill")
	}
}

func TestLimiterFullEvictsInsteadOfFailingClosed(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter(3, time.Minute, func() time.Time { return now })
	l.maxItems = 4
	for i := 0; i < 3; i++ {
		l.Allow("busy") // fully used: must survive eviction
	}
	for _, k := range []string{"a", "b", "c", "d", "e", "f"} {
		if !l.Allow(k) {
			t.Fatalf("new key %q refused while the map is full", k)
		}
	}
	if len(l.buckets) > l.maxItems {
		t.Fatalf("map grew to %d", len(l.buckets))
	}
	if l.Allow("busy") {
		t.Fatal("exhausted bucket was evicted ahead of fresher ones")
	}
}

func TestLockoutEscalates(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	l := Lockout{Window: 24 * time.Hour, Steps: []LockoutStep{{3, time.Hour}, {5, 24 * time.Hour}}}
	var st LockoutState
	fail := func(n int) {
		for i := 0; i < n; i++ {
			st = l.Fail(st, now)
		}
	}
	fail(2)
	if locked, _ := st.Locked(now); locked {
		t.Fatal("locked too early")
	}
	fail(1)
	if locked, until := st.Locked(now); !locked || !until.Equal(now.Add(time.Hour)) {
		t.Fatalf("after 3: %v %v", locked, until)
	}
	if locked, _ := (LockoutState{}).Locked(now); locked {
		t.Fatal("clean state locked")
	}
	now = now.Add(time.Hour)
	if locked, _ := st.Locked(now); locked {
		t.Fatal("1h lock did not lift")
	}
	fail(2)
	if locked, until := st.Locked(now); !locked || !until.Equal(now.Add(24*time.Hour)) {
		t.Fatalf("after 5: %v %v", locked, until)
	}
	// Once the window and the lock are both over, counting starts again.
	now = now.Add(24 * time.Hour)
	fail(2)
	if locked, _ := st.Locked(now); locked || st.Failures != 2 || !st.WindowStart.Equal(now) {
		t.Fatalf("window did not restart: %+v", st)
	}
	// Failures during a lock that outlasts the window still count towards the next step.
	st = LockoutState{}
	fail(5)
	now = now.Add(23 * time.Hour)
	fail(1)
	if st.Failures != 6 {
		t.Fatalf("failures = %d, want 6", st.Failures)
	}
}
