package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ErrCursorExpired means the tombstones a device would need were pruned: it must resync from 0.
var ErrCursorExpired = errors.New("cursor expired")

// BlobMeta is a blob without its data (change feed).
type BlobMeta struct {
	ID      string
	EntryID string
	Size    int64
}

// Changes is one page of a user's change feed (SPEC §5.2).
type Changes struct {
	Cursor         int64
	More           bool
	Entries        []Entry
	Blobs          []BlobMeta
	DeletedEntries []string
	DeletedBlobs   []string
	Settings       *Sealed
}

// ChangesSince returns everything that changed after `since`. The page ends after `limit`
// entries (with bodies), or sooner once their ciphertext adds up to maxBytes: an entry that
// would take the page past maxBytes is left for the next one, except that a page always
// carries at least one entry, however large. Blob metadata, tombstones and settings are
// returned for the same seq window, so the cursor never skips anything. since = 0 returns
// the whole current state (no tombstones needed).
func (s *Store) ChangesSince(ctx context.Context, userID string, since int64, limit int, maxBytes int64) (*Changes, error) {
	tx, err := s.db.beginRead(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var head, floor int64
	err = tx.QueryRowContext(ctx, `SELECT sync_seq, tombstone_floor FROM users WHERE id = ?`, userID).Scan(&head, &floor)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if since > 0 && since < floor {
		return nil, ErrCursorExpired
	}
	if since > head {
		// A cursor from the future (e.g. the database was restored from a backup): start over.
		return nil, ErrCursorExpired
	}

	out := &Changes{Cursor: head, Entries: []Entry{}, Blobs: []BlobMeta{}, DeletedEntries: []string{}, DeletedBlobs: []string{}}
	rows, err := tx.QueryContext(ctx, `SELECT id, created_at, updated_at, version, header_nonce, header_ct, body_nonce, body_ct, seq
		FROM entries WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?`, userID, since, limit+1)
	if err != nil {
		return nil, err
	}
	// Rows are read one at a time and the loop stops at the first that doesn't fit, so no
	// more than a page (plus that one row) is ever held in memory.
	var (
		lastSeq int64
		size    int64
	)
	for rows.Next() {
		var (
			e                     Entry
			created, updated, seq int64
		)
		if err := rows.Scan(&e.ID, &created, &updated, &e.Version, &e.Header.Nonce, &e.Header.CT, &e.Body.Nonce, &e.Body.CT, &seq); err != nil {
			rows.Close()
			return nil, err
		}
		n := int64(len(e.Header.Nonce) + len(e.Header.CT) + len(e.Body.Nonce) + len(e.Body.CT))
		if len(out.Entries) >= limit || len(out.Entries) > 0 && size+n > maxBytes {
			// Seqs are unique per user, so cutting at the last returned entry's seq is exact.
			out.Cursor = lastSeq
			out.More = true
			break
		}
		e.UserID = userID
		e.CreatedAt, e.UpdatedAt = fromMS(created), fromMS(updated)
		out.Entries = append(out.Entries, e)
		lastSeq, size = seq, size+n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	upto := out.Cursor

	brows, err := tx.QueryContext(ctx, `SELECT id, entry_id, size FROM blobs WHERE user_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
		userID, since, upto)
	if err != nil {
		return nil, err
	}
	for brows.Next() {
		var (
			b     BlobMeta
			entry sql.NullString
		)
		if err := brows.Scan(&b.ID, &entry, &b.Size); err != nil {
			brows.Close()
			return nil, err
		}
		b.EntryID = entry.String
		out.Blobs = append(out.Blobs, b)
	}
	brows.Close()
	if err := brows.Err(); err != nil {
		return nil, err
	}

	if since > 0 {
		trows, err := tx.QueryContext(ctx, `SELECT kind, item_id FROM tombstones WHERE user_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
			userID, since, upto)
		if err != nil {
			return nil, err
		}
		for trows.Next() {
			var kind, id string
			if err := trows.Scan(&kind, &id); err != nil {
				trows.Close()
				return nil, err
			}
			if kind == "entry" {
				out.DeletedEntries = append(out.DeletedEntries, id)
			} else {
				out.DeletedBlobs = append(out.DeletedBlobs, id)
			}
		}
		trows.Close()
		if err := trows.Err(); err != nil {
			return nil, err
		}
	}

	var v Sealed
	err = tx.QueryRowContext(ctx, `SELECT nonce, ct FROM settings WHERE user_id = ? AND seq > ? AND seq <= ?`, userID, since, upto).
		Scan(&v.Nonce, &v.CT)
	switch {
	case err == nil:
		out.Settings = &v
	case !errors.Is(err, sql.ErrNoRows):
		return nil, err
	}
	return out, nil
}

// PruneTombstones deletes tombstones older than `before` and raises each affected user's
// tombstone floor, so devices with an older cursor know to resync. Returns how many were removed.
func (s *Store) PruneTombstones(ctx context.Context, before time.Time) (int64, error) {
	var n int64
	err := s.inTx(ctx, func(tx *Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET tombstone_floor = `+tx.d.greatest()+`(tombstone_floor, (
				SELECT MAX(seq) FROM tombstones t WHERE t.user_id = users.id AND t.deleted_at < ?))
			WHERE EXISTS (SELECT 1 FROM tombstones t WHERE t.user_id = users.id AND t.deleted_at < ?)`, ms(before), ms(before)); err != nil {
			return err
		}
		var err error
		n, err = rowsAffected(tx.ExecContext(ctx, `DELETE FROM tombstones WHERE deleted_at < ?`, ms(before)))
		return err
	})
	return n, err
}
