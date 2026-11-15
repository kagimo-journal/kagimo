-- Sync change feed (SPEC §5.2). Every write to a user's entries, blobs or settings takes the next
-- value of that user's `sync_seq` counter and stores it on the row; deletions leave a tombstone
-- carrying their own seq. A device asks for everything with a seq above the last one it saw.
ALTER TABLE users ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
-- Tombstones with a seq at or below this were pruned: a device whose cursor is older must resync.
ALTER TABLE users ADD COLUMN tombstone_floor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blobs ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE tombstones (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('entry', 'blob')),
    item_id    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, item_id)
);
CREATE INDEX tombstones_user_seq ON tombstones(user_id, seq);
CREATE INDEX entries_user_seq ON entries(user_id, seq);
CREATE INDEX blobs_user_seq ON blobs(user_id, seq);

-- Existing rows get distinct, increasing seqs per user: entries, then blobs, then settings.
UPDATE entries SET seq = (
    SELECT n FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, id) AS n FROM entries) r
    WHERE r.id = entries.id);
UPDATE blobs SET seq = (SELECT COUNT(*) FROM entries e WHERE e.user_id = blobs.user_id) + (
    SELECT n FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, id) AS n FROM blobs) r
    WHERE r.id = blobs.id);
UPDATE settings SET seq = 1
    + (SELECT COUNT(*) FROM entries e WHERE e.user_id = settings.user_id)
    + (SELECT COUNT(*) FROM blobs b WHERE b.user_id = settings.user_id);
UPDATE users SET sync_seq =
      (SELECT COUNT(*) FROM entries e WHERE e.user_id = users.id)
    + (SELECT COUNT(*) FROM blobs b WHERE b.user_id = users.id)
    + (SELECT COUNT(*) FROM settings s WHERE s.user_id = users.id);
