package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
)

// TestDatabaseURLEnv, when set to a postgres:// URL, makes the Go tests run against that
// Postgres database instead of SQLite (see OpenForTest).
const TestDatabaseURLEnv = "JOURNAL_TEST_DATABASE_URL"

// OpenForTest opens a new, empty database for one test: journal.db in dir, or, if
// JOURNAL_TEST_DATABASE_URL is set, a schema of its own in that Postgres database. cleanup
// closes the store and, for Postgres, drops the schema.
func OpenForTest(ctx context.Context, dir string) (s *Store, cleanup func(), err error) {
	base := os.Getenv(TestDatabaseURLEnv)
	if base == "" {
		s, err = Open(ctx, filepath.Join(dir, "journal.db"))
		if err != nil {
			return nil, nil, err
		}
		return s, func() { s.Close() }, nil
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", TestDatabaseURLEnv, err)
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return nil, nil, err
	}
	schema := "test_" + hex.EncodeToString(b)
	admin, err := sql.Open("pgx", base)
	if err != nil {
		return nil, nil, err
	}
	if _, err := admin.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		admin.Close()
		return nil, nil, fmt.Errorf("create test schema: %w", err)
	}
	drop := func() {
		admin.ExecContext(context.Background(), `DROP SCHEMA `+schema+` CASCADE`)
		admin.Close()
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	s, err = OpenPostgres(ctx, u.String())
	if err != nil {
		drop()
		return nil, nil, err
	}
	return s, func() { s.Close(); drop() }, nil
}
