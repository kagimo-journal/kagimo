package auth

import "time"

// LockoutStep is one rung of an escalating lockout: after Failures failures
// within the window, the key is locked for Lock.
type LockoutStep struct {
	Failures int
	Lock     time.Duration
}

// Lockout counts failures in a fixed window and locks for increasing durations as
// the count crosses each step. It is used for TOTP codes (SPEC §5.1 "Rate limits"),
// where a short-term token bucket alone still leaves hundreds of guesses per day.
//
// It is only the rule: the state it works on (LockoutState) is kept by the caller,
// in the database, so that a restart does not forget failures or lift a lock.
type Lockout struct {
	Window time.Duration
	Steps  []LockoutStep // ascending by Failures
}

// LockoutState is one key's failure count. The zero value is a clean slate.
type LockoutState struct {
	WindowStart time.Time
	Failures    int
	LockedUntil time.Time
}

// Locked reports whether the state is locked at now, and until when.
func (st LockoutState) Locked(now time.Time) (bool, time.Time) {
	if now.Before(st.LockedUntil) {
		return true, st.LockedUntil
	}
	return false, time.Time{}
}

// Fail returns st with one more failure at now, applying the highest step reached.
// A window that has run out (and whose lock, if any, has lifted) starts afresh.
func (l Lockout) Fail(st LockoutState, now time.Time) LockoutState {
	if st.Failures == 0 || now.Sub(st.WindowStart) >= l.Window && !now.Before(st.LockedUntil) {
		st = LockoutState{WindowStart: now}
	}
	st.Failures++
	for _, step := range l.Steps {
		if st.Failures == step.Failures {
			if until := now.Add(step.Lock); until.After(st.LockedUntil) {
				st.LockedUntil = until
			}
		}
	}
	return st
}
