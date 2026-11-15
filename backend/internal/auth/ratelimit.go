package auth

import (
	"sync"
	"time"
)

// Limiter is a fixed-capacity token-bucket rate limiter keyed by string.
//
// It is used in two ways: Allow consumes a token per event (request rate
// limits), while Exhausted + Allow count only failures (per-account lockouts).
type Limiter struct {
	mu       sync.Mutex
	rate     float64 // tokens per second
	burst    float64
	buckets  map[string]*bucket
	now      func() time.Time
	lastGC   time.Time
	maxItems int
}

type bucket struct {
	tokens float64
	last   time.Time
}

// evictSample is how many buckets are inspected when the map is full and a
// bucket has to be evicted to make room for a new key.
const evictSample = 32

// NewLimiter allows `limit` events per `per` for each key, with burst = limit.
func NewLimiter(limit int, per time.Duration, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{
		rate:     float64(limit) / per.Seconds(),
		burst:    float64(limit),
		buckets:  make(map[string]*bucket),
		now:      now,
		maxItems: 100_000,
	}
}

// Allow consumes one token for key and reports whether the event is allowed.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.gc(now)
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.maxItems {
			l.evict(now)
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	l.refill(b, now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Exhausted reports whether key has no tokens left, without consuming one.
// Unknown keys are never exhausted.
func (l *Limiter) Exhausted(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		return false
	}
	l.refill(b, l.now())
	return b.tokens < 1
}

func (l *Limiter) refill(b *bucket, now time.Time) {
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens = min(l.burst, b.tokens+elapsed*l.rate)
		b.last = now
	}
}

// evict makes room for one new bucket when the map is full (likely an attack
// rotating keys). Rather than refusing every unseen key, which would lock out
// all legitimate users, it drops the bucket with the most tokens left among a
// random sample: that one carries the least rate-limiting state. Called with
// mu held.
func (l *Limiter) evict(now time.Time) {
	var (
		victim string
		best   = -1.0
		seen   int
	)
	for k, b := range l.buckets { // map iteration order is randomised
		l.refill(b, now)
		if b.tokens > best {
			victim, best = k, b.tokens
		}
		if seen++; seen >= evictSample {
			break
		}
	}
	delete(l.buckets, victim)
}

// gc drops buckets that have fully refilled. Called with mu held.
func (l *Limiter) gc(now time.Time) {
	if now.Sub(l.lastGC) < time.Minute {
		return
	}
	l.lastGC = now
	full := time.Duration(l.burst / l.rate * float64(time.Second))
	for k, b := range l.buckets {
		if now.Sub(b.last) >= full {
			delete(l.buckets, k)
		}
	}
}

// Keys returns the keys currently tracked (for tests and diagnostics).
func (l *Limiter) Keys() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, 0, len(l.buckets))
	for k := range l.buckets {
		out = append(out, k)
	}
	return out
}
