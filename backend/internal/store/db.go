// Package store is the persistence layer: SQLite by default, Postgres if asked for.
//
// The server never stores plaintext journal content: entries, blobs and settings
// are opaque ciphertext produced by the client.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver
	_ "modernc.org/sqlite"             // registers the "sqlite" driver
)

// One folder of migrations per dialect. A schema change adds a file with the same number
// to both.
//
//go:embed migrations/sqlite/*.sql migrations/postgres/*.sql
var migrationFS embed.FS

// Common errors returned by the store.
var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
	// ErrInvalidInvite: no unused invite has that code.
	ErrInvalidInvite = errors.New("invalid invite")
)

// Store wraps the database.
type Store struct {
	db *DB
	d  dialect
}

// DatabaseURLEnv names the environment variable that selects Postgres. It is read from the
// environment only, never a flag, because the URL carries the database password.
const DatabaseURLEnv = "JOURNAL_DATABASE_URL"

// OpenDatabase opens the database the server is configured for and applies migrations:
// Postgres if databaseURL (a postgres:// URL) is set, otherwise the SQLite file journal.db
// in dataDir.
func OpenDatabase(ctx context.Context, dataDir, databaseURL string) (*Store, error) {
	if databaseURL == "" {
		return Open(ctx, filepath.Join(dataDir, "journal.db"))
	}
	if !strings.HasPrefix(databaseURL, "postgres://") && !strings.HasPrefix(databaseURL, "postgresql://") {
		return nil, fmt.Errorf("%s must be a postgres:// URL (leave it unset to use SQLite)", DatabaseURLEnv)
	}
	return OpenPostgres(ctx, databaseURL)
}

// Open opens (creating if needed) the SQLite database file at path and applies migrations.
func Open(ctx context.Context, path string) (*Store, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Set("_txlock", "immediate")
	dsn := "file:" + abs + "?" + q.Encode()

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	s := newStore(db, sqlite)
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	if err := restrictFiles(abs); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// OpenPostgres connects to the Postgres database at databaseURL and applies migrations.
// The database must exist and be empty or already this server's; the role needs to create
// tables in it.
func OpenPostgres(ctx context.Context, databaseURL string) (*Store, error) {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}
	s := newStore(db, postgres)
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func newStore(db *sql.DB, d dialect) *Store {
	return &Store{db: &DB{raw: db, d: d}, d: d}
}

// Dialect is "sqlite" or "postgres".
func (s *Store) Dialect() string { return s.d.String() }

// restrictFiles makes the database and its WAL/shared-memory files readable by
// the owner only, whatever the process umask was when SQLite created them.
func restrictFiles(path string) error {
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if err := os.Chmod(p, 0o600); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("restrict permissions of %s: %w", filepath.Base(p), err)
		}
	}
	return nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.raw.Close() }

// DB exposes the underlying handle (used by tests).
func (s *Store) DB() *DB { return s.db }

type migration struct {
	version int
	name    string
	sql     string
}

func loadMigrations(d dialect) ([]migration, error) {
	dir := "migrations/" + d.String()
	entries, err := fs.ReadDir(migrationFS, dir)
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(name, "_")
		if !ok {
			return nil, fmt.Errorf("migration %q: name must be NNNN_description.sql", name)
		}
		v, err := strconv.Atoi(prefix)
		if err != nil {
			return nil, fmt.Errorf("migration %q: bad version: %w", name, err)
		}
		body, err := migrationFS.ReadFile(dir + "/" + name)
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: v, name: name, sql: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i := 1; i < len(out); i++ {
		if out[i].version == out[i-1].version {
			return nil, fmt.Errorf("duplicate migration version %d", out[i].version)
		}
	}
	return out, nil
}

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	migs, err := loadMigrations(s.d)
	if err != nil {
		return err
	}
	for _, m := range migs {
		if err := s.applyMigration(ctx, m); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) applyMigration(ctx context.Context, m migration) error {
	tx, err := s.db.begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, m.version).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, m.sql); err != nil {
		return fmt.Errorf("apply migration %s: %w", m.name, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)`,
		m.version, m.name, time.Now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

// inTx runs fn inside a write transaction.
func (s *Store) inTx(ctx context.Context, fn func(tx *Tx) error) error {
	tx, err := s.db.begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func ms(t time.Time) int64 { return t.UnixMilli() }

func fromMS(v int64) time.Time { return time.UnixMilli(v).UTC() }

// msOrZero is ms(t), with the zero time stored as 0.
func msOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return ms(t)
}

func fromNullMS(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := fromMS(v.Int64)
	return &t
}

func rowsAffected(res sql.Result, err error) (int64, error) {
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
