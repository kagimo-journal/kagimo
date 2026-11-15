package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"journal/internal/store"
)

// --- entries ---

type entryMetaJSON struct {
	ID        string     `json:"id"`
	CreatedAt string     `json:"createdAt"`
	UpdatedAt string     `json:"updatedAt"`
	Version   int64      `json:"version"`
	Header    sealedJSON `json:"header"`
}

type entryJSON struct {
	entryMetaJSON
	Body sealedJSON `json:"body"`
}

// The entry list is read from the database and written out a page at a time, so its memory
// use doesn't grow with the journal.
const (
	listPageSize  = 500
	listPageBytes = 1 << 20
)

// handleListEntries answers with one JSON array of every entry's header, newest first. The
// array is streamed: once the first page is on its way the status is already sent, so a
// failure after that can only cut the connection short (the client then sees a broken
// response, never a list that silently stops early).
func (s *Server) handleListEntries(w http.ResponseWriter, r *http.Request) error {
	uid := caller(r).user.ID
	var (
		after *store.Entry
		sent  int
	)
	for {
		page, more, err := s.store.ListEntries(r.Context(), uid, after, listPageSize, listPageBytes)
		if err != nil {
			if after == nil {
				return err
			}
			s.log.Error("entry list cut short", "sent", sent, "err", err)
			panic(http.ErrAbortHandler)
		}
		var buf bytes.Buffer
		if after == nil {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			buf.WriteByte('[')
		}
		for i := range page {
			e := &page[i]
			b, err := json.Marshal(entryMetaJSON{
				ID: e.ID, CreatedAt: ts(e.CreatedAt), UpdatedAt: ts(e.UpdatedAt), Version: e.Version,
				Header: encodeSealed(e.Header.Nonce, e.Header.CT),
			})
			if err != nil {
				panic(err) // strings and integers: cannot fail
			}
			if sent > 0 {
				buf.WriteByte(',')
			}
			buf.Write(b)
			sent++
		}
		if !more {
			buf.WriteString("]\n")
		}
		if _, err := w.Write(buf.Bytes()); err != nil {
			return nil // the client went away
		}
		if !more {
			return nil
		}
		after = &page[len(page)-1]
	}
}

func (s *Server) handleGetEntry(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	e, err := s.store.GetEntry(r.Context(), caller(r).user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, entryJSON{
		entryMetaJSON: entryMetaJSON{
			ID: e.ID, CreatedAt: ts(e.CreatedAt), UpdatedAt: ts(e.UpdatedAt), Version: e.Version,
			Header: encodeSealed(e.Header.Nonce, e.Header.CT),
		},
		Body: encodeSealed(e.Body.Nonce, e.Body.CT),
	})
}

type entryWriteReq struct {
	ID          string      `json:"id"`
	Header      *sealedJSON `json:"header"`
	Body        *sealedJSON `json:"body"`
	BaseVersion *int64      `json:"baseVersion"`
}

// maxHeaderCT bounds an entry header's ciphertext. A header holds a title (at most 300
// characters), a snippet, the date, a place, the weather and a few counts: well under a
// kilobyte. Headers are what lists return for every entry at once, so unlike bodies
// (bounded by maxJSONBody) they get a tight cap of their own.
const maxHeaderCT = 64 << 10

var errHeaderTooLarge = errf(http.StatusRequestEntityTooLarge, "header_too_large", "the entry header is too large")

func (req *entryWriteReq) sealed() (header, body store.Sealed, err error) {
	if header.Nonce, header.CT, err = req.Header.decode("header"); err != nil {
		return
	}
	if len(header.CT) > maxHeaderCT {
		return header, body, errHeaderTooLarge
	}
	body.Nonce, body.CT, err = req.Body.decode("body")
	return
}

func (s *Server) handleCreateEntry(w http.ResponseWriter, r *http.Request) error {
	var req entryWriteReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	id, err := parseUUIDv4("id", req.ID)
	if err != nil {
		return err
	}
	header, body, err := req.sealed()
	if err != nil {
		return err
	}
	now := s.cfg.Now()
	u := caller(r).user
	e := &store.Entry{ID: id, UserID: u.ID, CreatedAt: now, UpdatedAt: now, Header: header, Body: body}
	if err := s.store.CreateEntry(r.Context(), e, s.storageLimit(u)); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return errf(http.StatusConflict, "entry_exists", "an entry with this id already exists")
		}
		return s.quotaErr(r.Context(), u, err)
	}
	return writeJSON(w, http.StatusOK, map[string]any{
		"id": e.ID, "version": e.Version, "createdAt": ts(e.CreatedAt), "updatedAt": ts(e.UpdatedAt), "seq": e.Seq,
	})
}

func (s *Server) handleUpdateEntry(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	var req entryWriteReq
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	if req.BaseVersion == nil || *req.BaseVersion < 1 {
		return badRequest("baseVersion is required")
	}
	header, body, err := req.sealed()
	if err != nil {
		return err
	}
	now := s.cfg.Now()
	u := caller(r).user
	version, seq, current, err := s.store.UpdateEntry(r.Context(), u.ID, id, *req.BaseVersion, header, body, now, s.storageLimit(u))
	switch {
	case errors.Is(err, store.ErrNotFound):
		return errNotFound
	case errors.Is(err, store.ErrConflict):
		e := errf(http.StatusConflict, "version_conflict", "this entry was changed elsewhere")
		e.extra = map[string]any{"currentVersion": current}
		return e
	case err != nil:
		return s.quotaErr(r.Context(), u, err)
	}
	return writeJSON(w, http.StatusOK, map[string]any{"version": version, "updatedAt": ts(now), "seq": seq})
}

func (s *Server) handleDeleteEntry(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	seq, err := s.store.DeleteEntry(r.Context(), caller(r).user.ID, id, s.cfg.Now())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errNotFound
		}
		return err
	}
	return okSeq(w, seq)
}

// --- blobs ---

// handleUploadBlob refuses every upload: Kagimo stores text only. Photos already stored can
// still be downloaded and deleted.
func (s *Server) handleUploadBlob(w http.ResponseWriter, r *http.Request) error {
	return errf(http.StatusGone, "photos_unsupported", "photos can no longer be stored; Kagimo keeps text only")
}

func (s *Server) handleGetBlob(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	b, err := s.store.GetBlob(r.Context(), caller(r).user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(int64(len(b.Data)), 10))
	h.Set("X-Blob-Nonce", b64(b.Nonce))
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(b.Data)
	}
	return nil
}

func (s *Server) handleDeleteBlob(w http.ResponseWriter, r *http.Request) error {
	id, err := pathUUID(r, "id")
	if err != nil {
		return err
	}
	seq, err := s.store.DeleteBlob(r.Context(), caller(r).user.ID, id, s.cfg.Now())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errNotFound
		}
		return err
	}
	return okSeq(w, seq)
}

// --- settings ---

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) error {
	v, err := s.store.GetSettings(r.Context(), caller(r).user.ID)
	if errors.Is(err, store.ErrNotFound) {
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, encodeSealed(v.Nonce, v.CT))
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) error {
	var req sealedJSON
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	nonce, ct, err := req.decode("settings")
	if err != nil {
		return err
	}
	u := caller(r).user
	seq, err := s.store.PutSettings(r.Context(), u.ID, store.Sealed{Nonce: nonce, CT: ct}, s.cfg.Now(), s.storageLimit(u))
	if err != nil {
		return s.quotaErr(r.Context(), u, err)
	}
	return okSeq(w, seq)
}

// --- sync (SPEC §5.2) ---

// A change-feed page ends after syncPageSize entries (with bodies) or, sooner, once their
// ciphertext adds up to syncPageBytes; an entry too big to fit is sent in a page of its own.
// The client follows `cursor` while `more` is set, so short pages cost it nothing, and the
// server never builds a response of more than a few megabytes.
const (
	syncPageSize  = 100
	syncPageBytes = 4 << 20
)

type syncBlobJSON struct {
	ID      string `json:"id"`
	EntryID string `json:"entryId,omitempty"`
	Size    int64  `json:"size"`
}

type syncJSON struct {
	Cursor   int64          `json:"cursor"`
	More     bool           `json:"more"`
	Entries  []entryJSON    `json:"entries"`
	Blobs    []syncBlobJSON `json:"blobs"`
	Deleted  syncDeleted    `json:"deleted"`
	Settings *sealedJSON    `json:"settings"`
}

type syncDeleted struct {
	Entries []string `json:"entries"`
	Blobs   []string `json:"blobs"`
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) error {
	var since int64
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			return badRequest("since must be a non-negative integer")
		}
		since = n
	}
	ch, err := s.store.ChangesSince(r.Context(), caller(r).user.ID, since, syncPageSize, syncPageBytes)
	if errors.Is(err, store.ErrCursorExpired) {
		return errf(http.StatusGone, "cursor_expired", "this device was away too long; it needs a full resync")
	}
	if err != nil {
		return err
	}
	out := syncJSON{
		Cursor:  ch.Cursor,
		More:    ch.More,
		Entries: make([]entryJSON, 0, len(ch.Entries)),
		Blobs:   make([]syncBlobJSON, 0, len(ch.Blobs)),
		Deleted: syncDeleted{Entries: ch.DeletedEntries, Blobs: ch.DeletedBlobs},
	}
	for _, e := range ch.Entries {
		out.Entries = append(out.Entries, entryJSON{
			entryMetaJSON: entryMetaJSON{
				ID: e.ID, CreatedAt: ts(e.CreatedAt), UpdatedAt: ts(e.UpdatedAt), Version: e.Version,
				Header: encodeSealed(e.Header.Nonce, e.Header.CT),
			},
			Body: encodeSealed(e.Body.Nonce, e.Body.CT),
		})
	}
	for _, b := range ch.Blobs {
		out.Blobs = append(out.Blobs, syncBlobJSON{ID: b.ID, EntryID: b.EntryID, Size: b.Size})
	}
	if ch.Settings != nil {
		v := encodeSealed(ch.Settings.Nonce, ch.Settings.CT)
		out.Settings = &v
	}
	s.metrics.syncPage(since, len(ch.Entries), len(ch.Blobs), len(ch.DeletedEntries)+len(ch.DeletedBlobs), ch.Settings != nil)
	return writeJSON(w, http.StatusOK, out)
}
