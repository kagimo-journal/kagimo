package api

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

type syncPage struct {
	Cursor  int64 `json:"cursor"`
	More    bool  `json:"more"`
	Entries []struct {
		ID      string `json:"id"`
		Version int64  `json:"version"`
		Body    struct {
			CT string `json:"ct"`
		} `json:"body"`
	} `json:"entries"`
	Blobs []struct {
		ID      string `json:"id"`
		EntryID string `json:"entryId"`
	} `json:"blobs"`
	Deleted struct {
		Entries []string `json:"entries"`
		Blobs   []string `json:"blobs"`
	} `json:"deleted"`
	Settings *struct {
		CT string `json:"ct"`
	} `json:"settings"`
}

func (a *account) sync(t *testing.T, since int64) syncPage {
	t.Helper()
	var p syncPage
	mustUnmarshal(t, a.c.mustStatus(200, "GET", fmt.Sprintf("/api/sync?since=%d", since), nil).body, &p)
	return p
}

func TestSyncFeed(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	b := env.activeUser("bob")

	full := a.sync(t, 0)
	if len(full.Entries) != 0 || full.Settings != nil {
		t.Fatalf("empty journal: %+v", full)
	}

	e1, e2 := newUUID(), newUUID()
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": e1, "header": sealed(40), "body": sealed(100)})
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": e2, "header": sealed(40), "body": sealed(100)})
	blob := newUUID()
	seedBlob(t, env, a.username, blob, e1, make([]byte, 64))
	a.c.mustStatus(200, "PUT", "/api/settings", sealed(30))
	// Bob's writes never show up in Alice's feed.
	b.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(40), "body": sealed(100)})

	p := a.sync(t, full.Cursor)
	if len(p.Entries) != 2 || p.Entries[0].ID != e1 || p.Entries[1].ID != e2 || p.Entries[0].Body.CT == "" {
		t.Fatalf("entries: %+v", p.Entries)
	}
	if len(p.Blobs) != 1 || p.Blobs[0].ID != blob || p.Blobs[0].EntryID != e1 || p.Settings == nil || p.More {
		t.Fatalf("blobs/settings: %+v", p)
	}
	if again := a.sync(t, p.Cursor); len(again.Entries)+len(again.Blobs) != 0 || again.Settings != nil || again.Cursor != p.Cursor {
		t.Fatalf("nothing new expected: %+v", again)
	}

	// An update moves the entry to the end of the feed; deletions arrive as tombstones.
	a.c.mustStatus(200, "PUT", "/api/entries/"+e1, map[string]any{"header": sealed(40), "body": sealed(100), "baseVersion": 1})
	a.c.mustStatus(200, "DELETE", "/api/entries/"+e2, nil)
	next := a.sync(t, p.Cursor)
	if len(next.Entries) != 1 || next.Entries[0].ID != e1 || next.Entries[0].Version != 2 {
		t.Fatalf("update: %+v", next.Entries)
	}
	if len(next.Deleted.Entries) != 1 || next.Deleted.Entries[0] != e2 {
		t.Fatalf("tombstone: %+v", next.Deleted)
	}
	a.c.mustStatus(200, "DELETE", "/api/blobs/"+blob, nil)
	if d := a.sync(t, next.Cursor); len(d.Deleted.Blobs) != 1 || d.Deleted.Blobs[0] != blob {
		t.Fatalf("blob tombstone: %+v", d.Deleted)
	}

	// A full sync carries only what exists now, never tombstones.
	if f := a.sync(t, 0); len(f.Entries) != 1 || len(f.Deleted.Entries) != 0 || len(f.Blobs) != 0 {
		t.Fatalf("full: %+v", f)
	}

	// A deleted entry may be created again under its id (edited offline elsewhere); the tombstone goes.
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": e2, "header": sealed(40), "body": sealed(100)})
	if f := a.sync(t, next.Cursor); len(f.Deleted.Entries) != 0 || len(f.Entries) != 1 || f.Entries[0].ID != e2 {
		t.Fatalf("resurrected: %+v", f)
	}

	if r := a.c.do("GET", "/api/sync?since=-1", nil); r.status != 400 {
		t.Fatalf("bad since: %d", r.status)
	}
	if r := a.c.do("GET", "/api/sync?since=999999", nil); r.status != http.StatusGone || r.errCode() != "cursor_expired" {
		t.Fatalf("future cursor: %d %s", r.status, r.body)
	}
}

func TestSyncPaging(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	total := syncPageSize + 7
	for i := 0; i < total; i++ {
		a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(20), "body": sealed(20)})
	}
	seen := map[string]bool{}
	var cursor int64
	for pages := 0; ; pages++ {
		if pages > 3 {
			t.Fatal("too many pages")
		}
		p := a.sync(t, cursor)
		for _, e := range p.Entries {
			if seen[e.ID] {
				t.Fatalf("duplicate %s", e.ID)
			}
			seen[e.ID] = true
		}
		cursor = p.Cursor
		if !p.More {
			break
		}
	}
	if len(seen) != total {
		t.Fatalf("saw %d of %d", len(seen), total)
	}
}

func TestSyncTombstonePruningExpiresOldCursors(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	id := newUUID()
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": id, "header": sealed(20), "body": sealed(20)})
	before := a.sync(t, 0).Cursor
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(20), "body": sealed(20)})
	a.c.mustStatus(200, "DELETE", "/api/entries/"+id, nil)

	// As if tombstoneAge had passed (advancing the clock that far would also expire the session).
	if n, err := env.st.PruneTombstones(context.Background(), env.clock.Now().Add(time.Hour)); err != nil || n != 1 {
		t.Fatalf("prune: %d %v", n, err)
	}
	if r := a.c.do("GET", fmt.Sprintf("/api/sync?since=%d", before), nil); r.status != http.StatusGone {
		t.Fatalf("old cursor after pruning: %d %s", r.status, r.body)
	}
	if p := a.sync(t, 0); len(p.Entries) != 1 {
		t.Fatalf("full resync: %+v", p)
	}
}

func TestNewMemberSyncsStraightAway(t *testing.T) {
	env := newEnv(t)
	env.signup("admin")
	m := env.signup("member")
	if r := m.c.do("GET", "/api/sync", nil); r.status != 200 {
		t.Fatalf("new member: %d %s", r.status, r.body)
	}
}

// Each write answers with the change-feed seq it took. They follow the cursor one by one while
// nobody else writes, so a device can step its cursor past its own changes (SPEC §5.2).
func TestWritesReturnSeq(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	cursor := a.sync(t, 0).Cursor

	seqOf := func(r resp) int64 {
		t.Helper()
		var v struct {
			Seq int64 `json:"seq"`
		}
		mustUnmarshal(t, r.body, &v)
		return v.Seq
	}
	e1, e2 := newUUID(), newUUID()
	got := []int64{
		seqOf(a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": e1, "header": sealed(40), "body": sealed(100)})),
		seqOf(a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": e2, "header": sealed(40), "body": sealed(100)})),
		seqOf(a.c.mustStatus(200, "PUT", "/api/entries/"+e1, map[string]any{"header": sealed(40), "body": sealed(100), "baseVersion": 1})),
		seqOf(a.c.mustStatus(200, "DELETE", "/api/entries/"+e2, nil)),
		seqOf(a.c.mustStatus(200, "PUT", "/api/settings", sealed(30))),
	}
	for i, s := range got {
		if s != cursor+int64(i)+1 {
			t.Fatalf("write %d: seq %d, want %d (all: %v)", i, s, cursor+int64(i)+1, got)
		}
	}
	if head := a.sync(t, got[len(got)-1]); head.Cursor != got[len(got)-1] || len(head.Entries) != 0 {
		t.Fatalf("feed head %d, want %d", head.Cursor, got[len(got)-1])
	}
}

// A page is cut by ciphertext size as well as by entry count, so the server never builds a
// response of tens of megabytes; the client's cursor/more loop still sees everything once.
func TestSyncPagesByBytes(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	const bodyLen = 500_000
	total := 2*(syncPageBytes/bodyLen) - 4 // two pages' worth, far fewer than syncPageSize
	for i := 0; i < total; i++ {
		a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(40), "body": sealed(bodyLen)})
	}
	seen := map[string]bool{}
	var cursor int64
	pages := 0
	for {
		if pages++; pages > 4 {
			t.Fatal("too many pages")
		}
		p := a.sync(t, cursor)
		if len(p.Entries) == 0 {
			t.Fatalf("page %d is empty", pages)
		}
		if p.Cursor <= cursor {
			t.Fatalf("page %d: cursor went from %d to %d", pages, cursor, p.Cursor)
		}
		if size := len(p.Entries) * bodyLen; size > syncPageBytes {
			t.Fatalf("page %d carries %d bytes of bodies, over the %d budget", pages, size, syncPageBytes)
		}
		for _, e := range p.Entries {
			if seen[e.ID] {
				t.Fatalf("duplicate %s", e.ID)
			}
			seen[e.ID] = true
		}
		cursor = p.Cursor
		if !p.More {
			break
		}
	}
	if len(seen) != total {
		t.Fatalf("saw %d of %d", len(seen), total)
	}
	if pages != 2 {
		t.Fatalf("%d pages, want 2", pages)
	}
}
