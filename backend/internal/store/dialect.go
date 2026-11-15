package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgconn"
)

// dialect is the database the store talks to. Every query in this package is written once,
// in SQLite's spelling with `?` placeholders; the few places where Postgres differs go
// through the methods below.
type dialect int

const (
	sqlite dialect = iota
	postgres
)

func (d dialect) String() string {
	if d == postgres {
		return "postgres"
	}
	return "sqlite"
}

var rebound sync.Map // query as written -> the same query with $1, $2, …

// rebind turns `?` placeholders into Postgres's `$n`. No query here has a `?` inside a
// string literal, so every one is a placeholder.
func (d dialect) rebind(q string) string {
	if d != postgres || !strings.Contains(q, "?") {
		return q
	}
	if v, ok := rebound.Load(q); ok {
		return v.(string)
	}
	var b strings.Builder
	b.Grow(len(q) + 8)
	n := 0
	for i := 0; i < len(q); i++ {
		if q[i] == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteByte(q[i])
	}
	out := b.String()
	rebound.Store(q, out)
	return out
}

// greatest names the function that returns the larger of two values.
func (d dialect) greatest() string {
	if d == postgres {
		return "GREATEST"
	}
	return "MAX"
}

// forUpdate is appended to a SELECT whose row the same transaction goes on to change.
// SQLite's write transactions already run one at a time (see Open); Postgres needs the row
// locked, or two transactions could both act on the value they read.
func (d dialect) forUpdate() string {
	if d == postgres {
		return " FOR UPDATE"
	}
	return ""
}

// usernameEq is the case-insensitive match on users.username: the column's NOCASE collation
// in SQLite, the unique index on lower(username) in Postgres. Usernames are ASCII (the API
// accepts a-z, 0-9, '.', '_' and '-'), so the two agree.
func (d dialect) usernameEq() string {
	if d == postgres {
		return "lower(username) = lower(?)"
	}
	return "username = ?"
}

func (d dialect) isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	if d == postgres {
		var pg *pgconn.PgError
		return errors.As(err, &pg) && pg.Code == "23505"
	}
	return strings.Contains(err.Error(), "UNIQUE constraint failed") || strings.Contains(err.Error(), "PRIMARY KEY")
}

// DB is the database handle: *sql.DB, with queries rebound for the dialect.
type DB struct {
	raw *sql.DB
	d   dialect
}

func (c *DB) ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error) {
	return c.raw.ExecContext(ctx, c.d.rebind(q), args...)
}

func (c *DB) QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error) {
	return c.raw.QueryContext(ctx, c.d.rebind(q), args...)
}

func (c *DB) QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row {
	return c.raw.QueryRowContext(ctx, c.d.rebind(q), args...)
}

// QueryRow is QueryRowContext without a context (tests).
func (c *DB) QueryRow(q string, args ...any) *sql.Row {
	return c.raw.QueryRowContext(context.Background(), c.d.rebind(q), args...)
}

// begin starts a write transaction.
func (c *DB) begin(ctx context.Context) (*Tx, error) {
	tx, err := c.raw.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	return &Tx{raw: tx, d: c.d}, nil
}

// beginRead starts a read-only transaction whose statements all see one snapshot. That is
// what any SQLite transaction gives; Postgres's default level takes a new snapshot per
// statement, so it is asked for REPEATABLE READ.
func (c *DB) beginRead(ctx context.Context) (*Tx, error) {
	opts := &sql.TxOptions{ReadOnly: true}
	if c.d == postgres {
		opts.Isolation = sql.LevelRepeatableRead
	}
	tx, err := c.raw.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &Tx{raw: tx, d: c.d}, nil
}

// Tx is a transaction: *sql.Tx, with queries rebound for the dialect.
type Tx struct {
	raw *sql.Tx
	d   dialect
}

func (t *Tx) ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error) {
	return t.raw.ExecContext(ctx, t.d.rebind(q), args...)
}

func (t *Tx) QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error) {
	return t.raw.QueryContext(ctx, t.d.rebind(q), args...)
}

func (t *Tx) QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row {
	return t.raw.QueryRowContext(ctx, t.d.rebind(q), args...)
}

func (t *Tx) Commit() error   { return t.raw.Commit() }
func (t *Tx) Rollback() error { return t.raw.Rollback() }

// lockUser makes the transaction the only one writing this user's data until it ends, which
// SQLite's one-writer-at-a-time transactions give for free. Everything that changes a user's
// entries, blobs, settings or passkeys takes this lock first, so two such transactions can
// neither interleave nor deadlock. A user that doesn't exist locks nothing; the caller's own
// statements report that.
func (t *Tx) lockUser(ctx context.Context, userID string) error {
	if t.d != postgres {
		return nil
	}
	var one int
	err := t.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ? FOR UPDATE`, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	return err
}

// signupLock is the Postgres advisory lock that makes sign-ups run one at a time.
const signupLock = 0x6a6f75726e616c // "journal"

// lockSignups makes the transaction the only one creating a user until it ends, so exactly
// one account can find the users table empty and become the first admin.
func (t *Tx) lockSignups(ctx context.Context) error {
	if t.d != postgres {
		return nil
	}
	_, err := t.raw.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(signupLock))
	return err
}
