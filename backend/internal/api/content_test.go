package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"testing"
	"time"

	"journal/internal/store"
)

func TestUnauthenticatedBlocked(t *testing.T) {
	env := newEnv(t)
	c := env.client()
	for _, path := range []string{"/api/me", "/api/entries", "/api/settings", "/api/admin/users", "/api/admin/stats"} {
		if r := c.do("GET", path, nil); r.status != 401 || r.errCode() != "unauthenticated" {
			t.Errorf("%s: %d %s", path, r.status, r.body)
		}
	}
}

func TestEntriesCRUDAndVersionConflict(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	id1, id2 := newUUID(), newUUID()
	created := a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": id1, "header": sealed(40), "body": sealed(100)}).json(t)
	if created["id"] != id1 || created["version"] != float64(1) || created["createdAt"] == nil {
		t.Fatalf("create: %v", created)
	}
	env.clock.Advance(time.Second)
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": id2, "header": sealed(40), "body": sealed(100)})

	// Duplicate id.
	if r := a.c.do("POST", "/api/entries", map[string]any{"id": id1, "header": sealed(40), "body": sealed(40)}); r.status != 409 {
		t.Fatalf("duplicate id: %d", r.status)
	}
	// Non-v4 id.
	if r := a.c.do("POST", "/api/entries", map[string]any{"id": "not-a-uuid", "header": sealed(40), "body": sealed(40)}); r.status != 400 {
		t.Fatalf("bad id: %d", r.status)
	}

	// List: newest first, headers only.
	var list []map[string]any
	r := a.c.mustStatus(200, "GET", "/api/entries", nil)
	mustUnmarshal(t, r.body, &list)
	if len(list) != 2 || list[0]["id"] != id2 || list[1]["id"] != id1 {
		t.Fatalf("list order: %v", list)
	}
	if _, hasBody := list[0]["body"]; hasBody {
		t.Fatalf("list must not include bodies")
	}

	newHeader, newBody := sealed(40), sealed(120)
	upd := a.c.mustStatus(200, "PUT", "/api/entries/"+id1, map[string]any{"header": newHeader, "body": newBody, "baseVersion": 1}).json(t)
	if upd["version"] != float64(2) {
		t.Fatalf("update: %v", upd)
	}
	got := a.c.mustStatus(200, "GET", "/api/entries/"+id1, nil).json(t)
	if got["version"] != float64(2) || got["body"].(map[string]any)["ct"] != newBody["ct"] || got["header"].(map[string]any)["nonce"] != newHeader["nonce"] {
		t.Fatalf("get after update: %v", got)
	}

	cases := []struct {
		name string
		base any
		want int
		code string
	}{
		{"stale base", 1, 409, "version_conflict"},
		{"future base", 5, 409, "version_conflict"},
		{"missing base", nil, 400, "bad_request"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{"header": sealed(40), "body": sealed(40)}
			if tc.base != nil {
				body["baseVersion"] = tc.base
			}
			r := a.c.do("PUT", "/api/entries/"+id1, body)
			if r.status != tc.want || r.errCode() != tc.code {
				t.Fatalf("got %d %s", r.status, r.body)
			}
			if tc.code == "version_conflict" && r.json(t)["currentVersion"] != float64(2) {
				t.Fatalf("conflict should report currentVersion: %s", r.body)
			}
		})
	}

	a.c.mustStatus(200, "DELETE", "/api/entries/"+id1, nil)
	a.c.mustStatus(404, "GET", "/api/entries/"+id1, nil)
	a.c.mustStatus(404, "DELETE", "/api/entries/"+id1, nil)
	a.c.mustStatus(404, "PUT", "/api/entries/"+id1, map[string]any{"header": sealed(40), "body": sealed(40), "baseVersion": 2})
}

func mustUnmarshal(t *testing.T, b []byte, v any) {
	t.Helper()
	if err := jsonUnmarshal(b, v); err != nil {
		t.Fatalf("decode %s: %v", b, err)
	}
}

// seedBlob stores a photo for username directly in the database, as one uploaded before the
// server stopped accepting photos. Returns the nonce.
func seedBlob(t *testing.T, env *testEnv, username, id, entryID string, data []byte) []byte {
	t.Helper()
	nonce := make([]byte, 12)
	rand.Read(nonce)
	b := &store.Blob{ID: id, UserID: env.userID(username), EntryID: entryID, Nonce: nonce, Data: data, Size: int64(len(data)), CreatedAt: env.clock.Now()}
	if err := env.st.CreateBlob(context.Background(), b, store.NoLimit); err != nil {
		t.Fatalf("seed blob: %v", err)
	}
	return nonce
}

func TestBlobs(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	entryID := newUUID()
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": entryID, "header": sealed(40), "body": sealed(40)})

	data := make([]byte, 5000)
	rand.Read(data)
	blobID := newUUID()
	nonce := seedBlob(t, env, "alice", blobID, entryID, data)

	// New photos are refused outright, whatever the request looks like.
	for _, path := range []string{
		"/api/blobs?id=" + newUUID() + "&entryId=" + entryID + "&nonce=" + base64.RawURLEncoding.EncodeToString(nonce),
		"/api/blobs?id=" + blobID + "&nonce=" + base64.RawURLEncoding.EncodeToString(nonce),
		"/api/blobs",
	} {
		if r := a.c.raw("POST", path, bytes.NewReader(data), "application/octet-stream"); r.status != http.StatusGone || r.errCode() != "photos_unsupported" {
			t.Fatalf("upload %s: %d %s", path, r.status, r.body)
		}
	}

	g := a.c.raw("GET", "/api/blobs/"+blobID, nil, "")
	if g.status != 200 || !bytes.Equal(g.body, data) {
		t.Fatalf("download: %d len=%d", g.status, len(g.body))
	}
	if g.header.Get("X-Blob-Nonce") != base64.StdEncoding.EncodeToString(nonce) {
		t.Fatalf("X-Blob-Nonce = %q", g.header.Get("X-Blob-Nonce"))
	}
	if g.header.Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", g.header.Get("Cache-Control"))
	}

	// Deleting the entry deletes its blobs.
	orphan := newUUID()
	seedBlob(t, env, "alice", orphan, "", data)
	a.c.mustStatus(200, "DELETE", "/api/entries/"+entryID, nil)
	a.c.mustStatus(404, "GET", "/api/blobs/"+blobID, nil)
	a.c.mustStatus(200, "GET", "/api/blobs/"+orphan, nil)
	a.c.mustStatus(200, "DELETE", "/api/blobs/"+orphan, nil)
	a.c.mustStatus(404, "GET", "/api/blobs/"+orphan, nil)
}

func TestSettings(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	if r := a.c.do("GET", "/api/settings", nil); r.status != http.StatusNoContent {
		t.Fatalf("empty settings: %d", r.status)
	}
	s1 := sealed(64)
	a.c.mustStatus(200, "PUT", "/api/settings", s1)
	got := a.c.mustStatus(200, "GET", "/api/settings", nil).json(t)
	if got["nonce"] != s1["nonce"] || got["ct"] != s1["ct"] {
		t.Fatalf("settings roundtrip: %v", got)
	}
	s2 := sealed(80)
	a.c.mustStatus(200, "PUT", "/api/settings", s2)
	if got := a.c.mustStatus(200, "GET", "/api/settings", nil).json(t); got["ct"] != s2["ct"] {
		t.Fatalf("settings overwrite: %v", got)
	}
	if r := a.c.do("PUT", "/api/settings", map[string]string{"nonce": "x", "ct": "y"}); r.status != 400 {
		t.Fatalf("invalid settings: %d", r.status)
	}
}

func TestCrossUserIsolation(t *testing.T) {
	env := newEnv(t)
	alice := env.activeUser("alice")
	bob := env.activeUser("bob")

	entryID := newUUID()
	alice.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": entryID, "header": sealed(40), "body": sealed(40)})
	blobID := newUUID()
	seedBlob(t, env, "alice", blobID, entryID, make([]byte, 64))
	alice.c.mustStatus(200, "PUT", "/api/settings", sealed(40))

	cases := []struct {
		name         string
		method, path string
		body         any
	}{
		{"get entry", "GET", "/api/entries/" + entryID, nil},
		{"update entry", "PUT", "/api/entries/" + entryID, map[string]any{"header": sealed(40), "body": sealed(40), "baseVersion": 1}},
		{"delete entry", "DELETE", "/api/entries/" + entryID, nil},
		{"get blob", "GET", "/api/blobs/" + blobID, nil},
		{"delete blob", "DELETE", "/api/blobs/" + blobID, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := bob.c.do(tc.method, tc.path, tc.body)
			if r.status != 404 || r.errCode() != "not_found" {
				t.Fatalf("got %d %s", r.status, r.body)
			}
		})
	}
	var list []map[string]any
	mustUnmarshal(t, bob.c.mustStatus(200, "GET", "/api/entries", nil).body, &list)
	if len(list) != 0 {
		t.Fatalf("bob sees alice's entries: %v", list)
	}
	if r := bob.c.do("GET", "/api/settings", nil); r.status != http.StatusNoContent {
		t.Fatalf("bob sees alice's settings: %d", r.status)
	}
	// Bob can't read, delete or overwrite alice's photo.
	bob.c.mustStatus(404, "GET", "/api/blobs/"+blobID, nil)
	bob.c.mustStatus(404, "DELETE", "/api/blobs/"+blobID, nil)
	if r := bob.c.raw("POST", "/api/blobs?id="+blobID+"&entryId="+entryID+"&nonce=AAAAAAAAAAAAAAAA", bytes.NewReader(make([]byte, 64)), "application/octet-stream"); r.status != http.StatusGone {
		t.Fatalf("blob overwrite: %d", r.status)
	}
	// Alice's data is intact.
	alice.c.mustStatus(200, "GET", "/api/entries/"+entryID, nil)
	alice.c.mustStatus(200, "GET", "/api/blobs/"+blobID, nil)
}

// Header ciphertext is capped (lists return every header at once); bodies are not affected.
func TestEntryHeaderSizeCap(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	id := newUUID()
	entry := func(headerLen int) map[string]any {
		return map[string]any{"id": id, "header": sealed(headerLen), "body": sealed(200_000), "baseVersion": 1}
	}
	if r := a.c.do("POST", "/api/entries", entry(maxHeaderCT+1)); r.status != http.StatusRequestEntityTooLarge || r.errCode() != "header_too_large" {
		t.Fatalf("oversized header on create: %d %s", r.status, r.body)
	}
	a.c.mustStatus(200, "POST", "/api/entries", entry(maxHeaderCT))
	if r := a.c.do("PUT", "/api/entries/"+id, entry(maxHeaderCT+1)); r.status != http.StatusRequestEntityTooLarge || r.errCode() != "header_too_large" {
		t.Fatalf("oversized header on update: %d %s", r.status, r.body)
	}
	a.c.mustStatus(200, "PUT", "/api/entries/"+id, entry(maxHeaderCT))
}

// GET /api/entries is one JSON array however long the journal is: it is put together a
// page at a time (by count and by size) without the pages showing.
func TestListEntriesStreamsEverything(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	var got []struct {
		ID        string `json:"id"`
		CreatedAt string `json:"createdAt"`
	}
	list := func() {
		t.Helper()
		r := a.c.mustStatus(200, "GET", "/api/entries", nil)
		if ct := r.header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Fatalf("content type %q", ct)
		}
		got = nil
		mustUnmarshal(t, r.body, &got)
	}
	list()
	if got == nil || len(got) != 0 {
		t.Fatalf("empty journal: %v", got)
	}

	uid := env.userID("alice")
	want := map[string]bool{}
	add := func(headerLen int) {
		t.Helper()
		e := &store.Entry{ID: newUUID(), UserID: uid, CreatedAt: env.clock.Now(), UpdatedAt: env.clock.Now(),
			Header: store.Sealed{Nonce: make([]byte, 12), CT: make([]byte, headerLen)},
			Body:   store.Sealed{Nonce: make([]byte, 12), CT: make([]byte, 32)}}
		if err := env.st.CreateEntry(context.Background(), e, store.NoLimit); err != nil {
			t.Fatal(err)
		}
		want[e.ID] = true
	}
	// More than a page by count, many of them made in the same millisecond (the order
	// between pages then rests on the id)…
	for i := 0; i < listPageSize+listPageSize/2; i++ {
		if i%100 == 0 {
			env.clock.Advance(time.Second)
		}
		add(40)
	}
	// …and more than a page by size.
	env.clock.Advance(time.Second)
	for i := 0; i < 3*listPageBytes/maxHeaderCT; i++ {
		add(maxHeaderCT)
	}
	list()
	if len(got) != len(want) {
		t.Fatalf("listed %d entries, want %d", len(got), len(want))
	}
	for i, e := range got {
		if !want[e.ID] {
			t.Fatalf("entry %d (%s) is unknown or repeated", i, e.ID)
		}
		delete(want, e.ID)
		if i > 0 && e.CreatedAt > got[i-1].CreatedAt {
			t.Fatalf("entry %d is newer than the one before it", i)
		}
	}
}
