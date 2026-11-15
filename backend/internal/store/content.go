package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Sealed is an opaque client ciphertext with its nonce.
type Sealed struct {
	Nonce []byte
	CT    []byte
}

// Entry is an encrypted journal entry.
type Entry struct {
	ID        string
	UserID    string
	CreatedAt time.Time
	UpdatedAt time.Time
	Version   int64
	Header    Sealed
	Body      Sealed // empty in list results
	// Seq is the change-feed number the last write took (set by CreateEntry).
	Seq int64
}

// ListEntries returns one page of a user's entries (headers only), newest first: those after
// the entry `after` in that order (nil: from the newest). The page ends after limit entries, or
// sooner once their ciphertext adds up to maxBytes (it always carries at least one). more
// reports whether entries remain. Each page is its own short query, so a caller writing a long
// journal out to a slow client holds neither the whole of it in memory nor a database
// connection while it waits.
func (s *Store) ListEntries(ctx context.Context, userID string, after *Entry, limit int, maxBytes int64) (page []Entry, more bool, err error) {
	q := `SELECT id, created_at, updated_at, version, header_nonce, header_ct FROM entries WHERE user_id = ?`
	args := []any{userID}
	if after != nil {
		q += ` AND (created_at, id) < (?, ?)`
		args = append(args, ms(after.CreatedAt), after.ID)
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY created_at DESC, id DESC LIMIT ?`, append(args, limit+1)...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	page = []Entry{}
	var size int64
	for rows.Next() {
		var (
			e                Entry
			created, updated int64
		)
		if err := rows.Scan(&e.ID, &created, &updated, &e.Version, &e.Header.Nonce, &e.Header.CT); err != nil {
			return nil, false, err
		}
		n := int64(len(e.Header.Nonce) + len(e.Header.CT))
		if len(page) >= limit || len(page) > 0 && size+n > maxBytes {
			return page, true, nil
		}
		e.UserID = userID
		e.CreatedAt, e.UpdatedAt = fromMS(created), fromMS(updated)
		page = append(page, e)
		size += n
	}
	return page, false, rows.Err()
}

// GetEntry loads one entry scoped to the user.
func (s *Store) GetEntry(ctx context.Context, userID, id string) (*Entry, error) {
	var (
		e                Entry
		created, updated int64
	)
	err := s.db.QueryRowContext(ctx, `SELECT id, created_at, updated_at, version, header_nonce, header_ct, body_nonce, body_ct
		FROM entries WHERE id = ? AND user_id = ?`, id, userID).
		Scan(&e.ID, &created, &updated, &e.Version, &e.Header.Nonce, &e.Header.CT, &e.Body.Nonce, &e.Body.CT)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	e.UserID = userID
	e.CreatedAt, e.UpdatedAt = fromMS(created), fromMS(updated)
	return &e, nil
}

// nextSeq takes the user's next change-feed sequence number (SPEC §5.2).
func nextSeq(ctx context.Context, tx *Tx, userID string) (int64, error) {
	var seq int64
	err := tx.QueryRowContext(ctx, `UPDATE users SET sync_seq = sync_seq + 1 WHERE id = ? RETURNING sync_seq`, userID).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return seq, err
}

// MaxTombstones is how many deletions the change feed remembers per user. Tombstones are
// rows that no storage limit counts and that stay until they are pruned by age, so creating
// and deleting entries in a loop would otherwise grow the database without bound. Past the
// cap the oldest are dropped early, exactly as pruning by age does (see PruneTombstones):
// the user's tombstone floor rises to the newest one dropped, and a device whose cursor is
// older than that is told cursor_expired and resyncs from scratch, which is always correct.
// Deleting is never refused. A variable so that tests can lower it.
var MaxTombstones = 5000

// addTombstone records a deletion in the change feed and returns its seq.
func addTombstone(ctx context.Context, tx *Tx, userID, kind, id string, now time.Time) (int64, error) {
	seq, err := nextSeq(ctx, tx, userID)
	if err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO tombstones (user_id, kind, item_id, seq, deleted_at) VALUES (?,?,?,?,?)
		ON CONFLICT(user_id, kind, item_id) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at`,
		userID, kind, id, seq, ms(now)); err != nil {
		return 0, err
	}
	return seq, capTombstones(ctx, tx, userID)
}

// capTombstones keeps the user's newest MaxTombstones tombstones, raising the tombstone
// floor past any it drops.
func capTombstones(ctx context.Context, tx *Tx, userID string) error {
	// The newest tombstone beyond the cap, if there is one: it and everything older go.
	var cut int64
	err := tx.QueryRowContext(ctx, `SELECT seq FROM tombstones WHERE user_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`,
		userID, MaxTombstones).Scan(&cut)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET tombstone_floor = `+tx.d.greatest()+`(tombstone_floor, ?) WHERE id = ?`, cut, userID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM tombstones WHERE user_id = ? AND seq <= ?`, userID, cut)
	return err
}

// NoLimit, passed as a write's storage limit, lets the account grow without bound.
const NoLimit int64 = -1

// ErrQuota is returned by a write that would take the account past its storage limit.
var ErrQuota = errors.New("storage limit reached")

const userStorageSQL = `SELECT ` + textStorageExpr + ` FROM users u WHERE u.id = ?`

// UsageBytes is how much the user stores on the server that counts against their storage
// limit: entries and settings, as ciphertext. Photos stored before uploads stopped don't count.
func (s *Store) UsageBytes(ctx context.Context, userID string) (int64, error) {
	var n sql.NullInt64
	err := s.db.QueryRowContext(ctx, userStorageSQL, userID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return n.Int64, err
}

// withinLimit runs a write and then, if limit >= 0, refuses it with ErrQuota when it made
// the account bigger and left it over the limit. Writes that shrink the account, or keep it
// the same size, always go through, so someone over the limit can still edit and tidy up.
func withinLimit(ctx context.Context, tx *Tx, userID string, limit int64, write func() error) error {
	if err := tx.lockUser(ctx, userID); err != nil {
		return err
	}
	if limit < 0 {
		return write()
	}
	var before, after sql.NullInt64
	if err := tx.QueryRowContext(ctx, userStorageSQL, userID).Scan(&before); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if err := write(); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, userStorageSQL, userID).Scan(&after); err != nil {
		return err
	}
	if after.Int64 > before.Int64 && after.Int64 > limit {
		return ErrQuota // the transaction rolls back
	}
	return nil
}

// CreateEntry inserts a new entry at version 1. ErrConflict if the id exists. An entry deleted
// earlier may be created again under the same id (a device kept editing it offline): its
// tombstone is dropped. ErrQuota if it would take the user past limit bytes (NoLimit: none).
func (s *Store) CreateEntry(ctx context.Context, e *Entry, limit int64) error {
	e.Version = 1
	return s.inTx(ctx, func(tx *Tx) error {
		return withinLimit(ctx, tx, e.UserID, limit, func() error { return createEntry(ctx, tx, e) })
	})
}

func createEntry(ctx context.Context, tx *Tx, e *Entry) error {
	seq, err := nextSeq(ctx, tx, e.UserID)
	if err != nil {
		return err
	}
	e.Seq = seq
	_, err = tx.ExecContext(ctx, `INSERT INTO entries (id, user_id, created_at, updated_at, version,
		header_nonce, header_ct, body_nonce, body_ct, seq) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		e.ID, e.UserID, ms(e.CreatedAt), ms(e.UpdatedAt), e.Version, e.Header.Nonce, e.Header.CT, e.Body.Nonce, e.Body.CT, seq)
	if tx.d.isUniqueViolation(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM tombstones WHERE user_id = ? AND kind = 'entry' AND item_id = ?`, e.UserID, e.ID)
	return err
}

// UpdateEntry performs an optimistic-concurrency update and returns the new version and the
// change-feed seq it took. It returns ErrNotFound if the entry does not exist for the user, or
// ErrConflict (with the current version) if baseVersion is stale. ErrQuota if the entry grew and
// the user is now past limit bytes (NoLimit: none).
func (s *Store) UpdateEntry(ctx context.Context, userID, id string, baseVersion int64, header, body Sealed, now time.Time, limit int64) (newVersion, seq, current int64, err error) {
	err = s.inTx(ctx, func(tx *Tx) error {
		return withinLimit(ctx, tx, userID, limit, func() error {
			newVersion, seq, current, err = updateEntry(ctx, tx, userID, id, baseVersion, header, body, now)
			return err
		})
	})
	return newVersion, seq, current, err
}

func updateEntry(ctx context.Context, tx *Tx, userID, id string, baseVersion int64, header, body Sealed, now time.Time) (newVersion, seq, current int64, err error) {
	seq, err = nextSeq(ctx, tx, userID)
	if err != nil {
		return 0, 0, 0, err
	}
	n, err := rowsAffected(tx.ExecContext(ctx, `UPDATE entries SET header_nonce = ?, header_ct = ?, body_nonce = ?, body_ct = ?,
		version = version + 1, updated_at = ?, seq = ? WHERE id = ? AND user_id = ? AND version = ?`,
		header.Nonce, header.CT, body.Nonce, body.CT, ms(now), seq, id, userID, baseVersion))
	if err != nil {
		return 0, 0, 0, err
	}
	if n == 1 {
		return baseVersion + 1, seq, 0, nil
	}
	err = tx.QueryRowContext(ctx, `SELECT version FROM entries WHERE id = ? AND user_id = ?`, id, userID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, 0, ErrNotFound
	}
	if err != nil {
		return 0, 0, 0, err
	}
	return 0, 0, current, ErrConflict
}

// DeleteEntry deletes an entry and its blobs, leaving a tombstone (only the id) so other devices
// delete their copies too. The blobs need no tombstones: devices drop an entry's images with it.
// Returns the tombstone's change-feed seq.
func (s *Store) DeleteEntry(ctx context.Context, userID, id string, now time.Time) (seq int64, err error) {
	err = s.inTx(ctx, func(tx *Tx) error {
		if err := tx.lockUser(ctx, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM blobs WHERE entry_id = ? AND user_id = ?`, id, userID); err != nil {
			return err
		}
		n, err := rowsAffected(tx.ExecContext(ctx, `DELETE FROM entries WHERE id = ? AND user_id = ?`, id, userID))
		if err := affectedOne(n, err); err != nil {
			return err
		}
		seq, err = addTombstone(ctx, tx, userID, "entry", id, now)
		return err
	})
	return seq, err
}

// EntryExists reports whether the user owns the entry.
func (s *Store) EntryExists(ctx context.Context, userID, id string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM entries WHERE id = ? AND user_id = ?`, id, userID).Scan(&n)
	return n > 0, err
}

// Blob is an encrypted image.
type Blob struct {
	ID        string
	UserID    string
	EntryID   string // empty when not attached
	Nonce     []byte
	Data      []byte
	Size      int64
	CreatedAt time.Time
}

// CreateBlob inserts a blob. ErrConflict if the id exists; ErrQuota if it would take the user
// past limit bytes (NoLimit: none).
func (s *Store) CreateBlob(ctx context.Context, b *Blob, limit int64) error {
	var entry sql.NullString
	if b.EntryID != "" {
		entry = sql.NullString{String: b.EntryID, Valid: true}
	}
	return s.inTx(ctx, func(tx *Tx) error {
		return withinLimit(ctx, tx, b.UserID, limit, func() error {
			seq, err := nextSeq(ctx, tx, b.UserID)
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO blobs (id, user_id, entry_id, nonce, data, size, created_at, seq)
				VALUES (?,?,?,?,?,?,?,?)`, b.ID, b.UserID, entry, b.Nonce, b.Data, b.Size, ms(b.CreatedAt), seq)
			if tx.d.isUniqueViolation(err) {
				return ErrConflict
			}
			return err
		})
	})
}

// GetBlob loads a blob scoped to the user.
func (s *Store) GetBlob(ctx context.Context, userID, id string) (*Blob, error) {
	var (
		b       Blob
		entry   sql.NullString
		created int64
	)
	err := s.db.QueryRowContext(ctx, `SELECT id, entry_id, nonce, data, size, created_at FROM blobs WHERE id = ? AND user_id = ?`,
		id, userID).Scan(&b.ID, &entry, &b.Nonce, &b.Data, &b.Size, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	b.UserID = userID
	b.EntryID = entry.String
	b.CreatedAt = fromMS(created)
	return &b, nil
}

// DeleteBlob deletes a blob scoped to the user, leaving a tombstone. Returns its seq.
func (s *Store) DeleteBlob(ctx context.Context, userID, id string, now time.Time) (seq int64, err error) {
	err = s.inTx(ctx, func(tx *Tx) error {
		if err := tx.lockUser(ctx, userID); err != nil {
			return err
		}
		n, err := rowsAffected(tx.ExecContext(ctx, `DELETE FROM blobs WHERE id = ? AND user_id = ?`, id, userID))
		if err := affectedOne(n, err); err != nil {
			return err
		}
		seq, err = addTombstone(ctx, tx, userID, "blob", id, now)
		return err
	})
	return seq, err
}

// DeleteOrphanBlobs deletes blobs created before `before` that are not attached to an
// existing entry of their owner: uploads without an entryId, and uploads for an entry
// that was never saved or was deleted before the upload landed. It returns how many
// blobs were removed.
func (s *Store) DeleteOrphanBlobs(ctx context.Context, before time.Time) (int64, error) {
	return rowsAffected(s.db.ExecContext(ctx, `DELETE FROM blobs
		WHERE created_at < ?
		  AND (entry_id IS NULL OR NOT EXISTS (
		        SELECT 1 FROM entries e WHERE e.id = blobs.entry_id AND e.user_id = blobs.user_id))`, ms(before)))
}

// GetSettings loads a user's encrypted settings.
func (s *Store) GetSettings(ctx context.Context, userID string) (*Sealed, error) {
	var v Sealed
	err := s.db.QueryRowContext(ctx, `SELECT nonce, ct FROM settings WHERE user_id = ?`, userID).Scan(&v.Nonce, &v.CT)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// PutSettings upserts a user's encrypted settings. ErrQuota if they grew and the user is now
// past limit bytes (NoLimit: none). Returns the change-feed seq the write took.
func (s *Store) PutSettings(ctx context.Context, userID string, v Sealed, now time.Time, limit int64) (seq int64, err error) {
	err = s.inTx(ctx, func(tx *Tx) error {
		return withinLimit(ctx, tx, userID, limit, func() error {
			var err error
			seq, err = nextSeq(ctx, tx, userID)
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO settings (user_id, nonce, ct, updated_at, seq) VALUES (?,?,?,?,?)
				ON CONFLICT(user_id) DO UPDATE SET nonce = excluded.nonce, ct = excluded.ct, updated_at = excluded.updated_at, seq = excluded.seq`,
				userID, v.Nonce, v.CT, ms(now), seq)
			return err
		})
	})
	return seq, err
}
