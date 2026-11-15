// Package admin implements the `journal admin` CLI, which operates directly on
// the database (useful before any admin can sign in, or for recovery).
package admin

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"
	"unicode/utf8"

	"journal/internal/store"
	"journal/internal/uuid"
)

const usage = `usage: journal admin [-data DIR] <command> [args]

commands:
  list                      list all accounts
  promote <user>            grant admin rights
  disable <user>            disable an account and revoke its sessions
  invite [note]             mint a single-use invite code (the account it makes is free)
`

// Run executes an admin subcommand. defaultData is the data directory from the
// environment/default; it can be overridden with -data.
func Run(ctx context.Context, args []string, defaultData string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("admin", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, usage) }
	dataDir := fs.String("data", defaultData, "data directory holding journal.db (not used when JOURNAL_DATABASE_URL selects Postgres)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) == 0 {
		fs.Usage()
		return errors.New("missing command")
	}
	st, err := store.OpenDatabase(ctx, *dataDir, os.Getenv(store.DatabaseURLEnv))
	if err != nil {
		return err
	}
	defer st.Close()

	cmd, cmdArgs := rest[0], rest[1:]
	switch cmd {
	case "list":
		return list(ctx, st, stdout)
	case "promote":
		u, err := oneUser(ctx, st, cmdArgs)
		if err != nil {
			return err
		}
		if err := st.SetAdmin(ctx, u.ID, true); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "%s is now an admin\n", u.Username)
	case "disable":
		u, err := oneUser(ctx, st, cmdArgs)
		if err != nil {
			return err
		}
		if err := st.SetStatus(ctx, u.ID, store.StatusDisabled, time.Now()); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "disabled %s and revoked their sessions\n", u.Username)
	case "invite":
		code, err := store.NewInviteCode()
		if err != nil {
			return err
		}
		inv := &store.Invite{ID: uuid.New(), Note: strings.TrimSpace(strings.Join(cmdArgs, " ")), CreatedAt: time.Now()}
		if err := st.CreateInvite(ctx, inv, code); err != nil {
			return err
		}
		fmt.Fprintln(stdout, code)
	default:
		fs.Usage()
		return fmt.Errorf("unknown command %q", cmd)
	}
	return nil
}

func oneUser(ctx context.Context, st *store.Store, args []string) (*store.UserSummary, error) {
	if len(args) != 1 {
		return nil, errors.New("expected exactly one username")
	}
	u, err := st.UserByUsername(ctx, strings.ToLower(strings.TrimSpace(args[0])))
	if errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("no such user %q", args[0])
	}
	if err != nil {
		return nil, err
	}
	return st.UserSummaryByID(ctx, u.ID)
}

func list(ctx context.Context, st *store.Store, out io.Writer) error {
	users, err := st.ListUsers(ctx)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "USERNAME\tSTATUS\tADMIN\tTOTP\tPASSKEYS\tSTORAGE\tCREATED\tNOTE")
	for _, u := range users {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%d\t%s\t%s\t%s\n", printable(u.Username), u.Status, yesNo(u.IsAdmin), yesNo(u.TOTPEnabled()),
			u.PasskeyCount, humanBytes(u.StorageBytes), u.CreatedAt.Format("2006-01-02"), oneLine(u.Note))
	}
	return tw.Flush()
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// printable replaces control and bidirectional-formatting characters (and
// invalid UTF-8) with U+FFFD, so stored text cannot send terminal escape
// sequences or reorder the output. Signup already rejects them (L1); this also
// covers rows written before that check existed.
func printable(s string) string {
	return strings.Map(func(r rune) rune {
		if r == utf8.RuneError || unicode.IsControl(r) || isBidiControl(r) {
			return '\uFFFD'
		}
		return r
	}, s)
}

func isBidiControl(r rune) bool {
	return r == 0x061C || r == 0x200E || r == 0x200F || (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

func oneLine(s string) string {
	s = printable(strings.Join(strings.Fields(s), " "))
	if r := []rune(s); len(r) > 40 {
		return string(r[:39]) + "…"
	}
	return s
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
