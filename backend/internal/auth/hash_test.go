package auth

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// holdHashSlots takes n hashing slots and returns a func that gives them back.
func holdHashSlots(t *testing.T, n int) (release func()) {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case hashSem <- struct{}{}:
		case <-time.After(5 * time.Second):
			t.Fatal("hashing slots never came free")
		}
	}
	var once sync.Once
	release = func() {
		once.Do(func() {
			for i := 0; i < n; i++ {
				<-hashSem
			}
		})
	}
	t.Cleanup(release)
	return release
}

func TestHashingIsCapped(t *testing.T) {
	ctx := context.Background()
	h, err := HashSecret(ctx, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	hashWaitFor = 20 * time.Millisecond
	t.Cleanup(func() { hashWaitFor = hashWait })
	release := holdHashSlots(t, hashSlots)

	// Every slot is taken: each entry point gives up with ErrBusy and computes nothing.
	before := HashCount()
	if _, err := HashSecret(ctx, []byte("secret")); !errors.Is(err, ErrBusy) {
		t.Fatalf("HashSecret: %v, want ErrBusy", err)
	}
	if ok, err := VerifySecret(ctx, h, []byte("secret")); ok || !errors.Is(err, ErrBusy) {
		t.Fatalf("VerifySecret: %v %v, want ErrBusy", ok, err)
	}
	if err := BurnVerify(ctx, []byte("secret")); !errors.Is(err, ErrBusy) {
		t.Fatalf("BurnVerify: %v, want ErrBusy", err)
	}
	if n := HashCount() - before; n != 0 {
		t.Fatalf("%d hashes started while every slot was taken", n)
	}
	// A malformed hash is still reported as such, without waiting for a slot.
	if _, err := VerifySecret(ctx, "nope", []byte("secret")); err == nil || errors.Is(err, ErrBusy) {
		t.Fatalf("malformed hash: %v", err)
	}

	// A caller whose request ends stops waiting straight away.
	hashWaitFor = time.Minute
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := HashSecret(cancelled, []byte("secret")); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled HashSecret: %v", err)
	}

	// A waiter gets the slot as soon as one is released.
	done := make(chan error, 1)
	go func() {
		ok, err := VerifySecret(ctx, h, []byte("secret"))
		if err == nil && !ok {
			err = errors.New("verification failed")
		}
		done <- err
	}()
	time.Sleep(10 * time.Millisecond)
	release()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("waiter: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("waiter never got a slot")
	}
	if n := HashCount() - before; n != 1 {
		t.Fatalf("%d hashes started, want 1", n)
	}
}

// Many callers at once all finish, hashSlots at a time.
func TestHashingQueuesCallers(t *testing.T) {
	const callers = 4 * hashSlots
	hashWaitFor = time.Minute // a slow machine must not turn queueing into ErrBusy
	t.Cleanup(func() { hashWaitFor = hashWait })
	var wg sync.WaitGroup
	errs := make(chan error, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if n := len(hashSem); n > hashSlots {
				errs <- errors.New("more slots in use than exist")
			}
			if err := BurnVerify(context.Background(), []byte("secret")); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}
