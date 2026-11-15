// Command journal runs the end-to-end encrypted journal server, or with the
// `admin` subcommand manages accounts directly in the database.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"journal/internal/admin"
	"journal/internal/api"
	"journal/internal/billing"
	"journal/internal/secret"
	"journal/internal/store"
	"journal/web"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	restrictUmask()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if len(os.Args) > 1 && os.Args[1] == "admin" {
		if err := admin.Run(ctx, os.Args[2:], envOr("JOURNAL_DATA", "./data"), os.Stdout, os.Stderr); err != nil {
			if !errors.Is(err, flag.ErrHelp) {
				fmt.Fprintln(os.Stderr, "error:", err)
			}
			os.Exit(1)
		}
		return
	}
	if err := serve(ctx, os.Args[1:], logger); err != nil {
		logger.Error("fatal", "err", err)
		os.Exit(1)
	}
}

type config struct {
	addr, data, origin, rpID, rpName, clientIPHeader, downloads, downloadsRepo string
	metricsAddr                                                                string

	stripeKey, stripeWebhook string
	monthCents, yearCents    int64 // 0 = that interval isn't offered
	priceCurrency            string
	freeKB, paidMB           int64
	freeDays                 int64
}

func parseFlags(args []string) (config, error) {
	var c config
	fs := flag.NewFlagSet("journal", flag.ContinueOnError)
	fs.StringVar(&c.addr, "addr", envOr("JOURNAL_ADDR", "127.0.0.1:8080"), "listen address (env JOURNAL_ADDR)")
	fs.StringVar(&c.metricsAddr, "metrics-addr", os.Getenv("JOURNAL_METRICS_ADDR"), "listen address for Prometheus /metrics, kept off the public port; empty = off (env JOURNAL_METRICS_ADDR)")
	fs.StringVar(&c.data, "data", envOr("JOURNAL_DATA", "./data"), "data directory for journal.db and secret.key (env JOURNAL_DATA); with JOURNAL_DATABASE_URL set to a postgres:// URL the database is Postgres instead and only secret.key lives here")
	fs.StringVar(&c.origin, "origin", envOr("JOURNAL_ORIGIN", "http://localhost:8080"), "public origin for WebAuthn and Origin checks (env JOURNAL_ORIGIN)")
	fs.StringVar(&c.rpID, "rp-id", os.Getenv("JOURNAL_RP_ID"), "WebAuthn RP id; defaults to the origin's host (env JOURNAL_RP_ID)")
	fs.StringVar(&c.rpName, "rp-name", envOr("JOURNAL_RP_NAME", "Kagimo"), "WebAuthn RP name / TOTP issuer (env JOURNAL_RP_NAME)")
	fs.StringVar(&c.downloads, "downloads", os.Getenv("JOURNAL_DOWNLOADS"), "folder of desktop app installers (.AppImage, .dmg, .exe) to offer on the front page; empty = none (env JOURNAL_DOWNLOADS)")
	fs.StringVar(&c.downloadsRepo, "downloads-repo", os.Getenv("JOURNAL_DOWNLOADS_REPO"), "GitHub repository (owner/name) whose latest release's installers the front page links to, instead of -downloads (env JOURNAL_DOWNLOADS_REPO)")
	fs.StringVar(&c.clientIPHeader, "client-ip-header", os.Getenv("JOURNAL_CLIENT_IP_HEADER"), "trusted header with the client IP set by an edge proxy, e.g. X-Real-IP (env JOURNAL_CLIENT_IP_HEADER)")
	// Secrets come only from the environment, never flags (which show up in `ps`).
	c.stripeKey = os.Getenv("STRIPE_SECRET_KEY")
	c.stripeWebhook = os.Getenv("STRIPE_WEBHOOK_SECRET")
	fs.Int64Var(&c.monthCents, "price-month-cents", envInt("JOURNAL_PRICE_MONTH_CENTS", 0), "monthly price in the currency's smallest unit; 0 = no monthly plan (env JOURNAL_PRICE_MONTH_CENTS)")
	fs.Int64Var(&c.yearCents, "price-year-cents", envInt("JOURNAL_PRICE_YEAR_CENTS", 1500), "yearly price in the currency's smallest unit; 0 = no yearly plan (env JOURNAL_PRICE_YEAR_CENTS)")
	fs.StringVar(&c.priceCurrency, "price-currency", envOr("JOURNAL_PRICE_CURRENCY", "aud"), "subscription currency (env JOURNAL_PRICE_CURRENCY)")
	fs.Int64Var(&c.freeKB, "free-storage-kb", envInt("JOURNAL_FREE_STORAGE_KB", api.DefaultFreeBytes/api.KB), "kilobytes a free account may store on the server during its free period (env JOURNAL_FREE_STORAGE_KB)")
	fs.Int64Var(&c.freeDays, "free-sync-days", envInt("JOURNAL_FREE_SYNC_DAYS", api.DefaultFreeDays), "days a new sync account syncs for free (env JOURNAL_FREE_SYNC_DAYS)")
	fs.Int64Var(&c.paidMB, "paid-storage-mb", envInt("JOURNAL_PAID_STORAGE_MB", 100), "fair-use megabytes for subscribed accounts (env JOURNAL_PAID_STORAGE_MB)")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "usage: journal [flags]\n       journal admin [-data DIR] list|promote|disable [user]\n\nflags:\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if fs.NArg() > 0 {
		return c, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	c.priceCurrency = strings.ToLower(c.priceCurrency)
	if c.monthCents < 0 || c.yearCents < 0 || c.monthCents+c.yearCents == 0 {
		return c, errors.New("-price-month-cents and -price-year-cents can't be negative, and one must be set")
	}
	if c.freeDays < 1 {
		return c, errors.New("-free-sync-days must be positive")
	}
	if c.freeKB < 1 || c.paidMB*api.MB < c.freeKB*api.KB {
		return c, errors.New("-free-storage-kb must be positive and -paid-storage-mb at least as large")
	}
	if c.stripeKey != "" && !strings.HasPrefix(c.stripeKey, "sk_") && !strings.HasPrefix(c.stripeKey, "rk_") {
		return c, errors.New("STRIPE_SECRET_KEY must be a secret (sk_…) or restricted (rk_…) key, not the publishable key")
	}
	if c.downloadsRepo != "" && !validRepo(c.downloadsRepo) {
		return c, errors.New("-downloads-repo must be a GitHub repository as owner/name")
	}
	if c.rpID == "" {
		u, err := url.Parse(c.origin)
		if err != nil {
			return c, fmt.Errorf("invalid -origin: %w", err)
		}
		c.rpID = u.Hostname()
	}
	return c, nil
}

// validRepo reports whether s is a GitHub repository written owner/name, each part made of
// letters, digits, '-', '_' and '.' (and not "." or "..").
func validRepo(s string) bool {
	owner, name, ok := strings.Cut(s, "/")
	if !ok {
		return false
	}
	for _, part := range []string{owner, name} {
		if part == "" || part == "." || part == ".." {
			return false
		}
		for _, r := range part {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
				return false
			}
		}
	}
	return true
}

func serve(ctx context.Context, args []string, logger *slog.Logger) error {
	cfg, err := parseFlags(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if err := prepareDataDir(cfg.data); err != nil {
		return err
	}
	keys, err := secret.LoadOrCreate(filepath.Join(cfg.data, "secret.key"))
	if err != nil {
		return err
	}
	st, err := store.OpenDatabase(ctx, cfg.data, os.Getenv(store.DatabaseURLEnv))
	if err != nil {
		return err
	}
	defer st.Close()

	var bill api.BillingConfig
	if cfg.stripeKey != "" {
		var plans []billing.Plan
		for _, p := range []struct {
			interval string
			cents    int64
		}{{"month", cfg.monthCents}, {"year", cfg.yearCents}} {
			if p.cents > 0 {
				plans = append(plans, billing.Plan{Amount: p.cents, Currency: cfg.priceCurrency, Interval: p.interval, Product: cfg.rpName})
			}
		}
		bill = api.BillingConfig{
			Stripe:        billing.New(cfg.stripeKey, plans, ""),
			WebhookSecret: cfg.stripeWebhook,
			FreeBytes:     cfg.freeKB * api.KB,
			FreeDays:      int(cfg.freeDays),
			PaidBytes:     cfg.paidMB * api.MB,
		}
		mode := "live"
		if strings.Contains(cfg.stripeKey, "_test_") {
			mode = "test"
		}
		logger.Info("billing on", "stripe", mode, "currency", cfg.priceCurrency, "monthCents", cfg.monthCents, "yearCents", cfg.yearCents,
			"freeStorageKB", cfg.freeKB, "freeSyncDays", cfg.freeDays, "paidStorageMB", cfg.paidMB, "webhook", cfg.stripeWebhook != "")
		if os.Getenv("STRIPE_PUBLISHABLE_KEY") != "" {
			logger.Warn("STRIPE_PUBLISHABLE_KEY is set but no longer used: Checkout is always Stripe's hosted page; the variable can be removed")
		}
		if cfg.stripeWebhook == "" {
			logger.Warn("STRIPE_WEBHOOK_SECRET is not set: renewals and cancellations are only picked up when a user's app syncs")
		}
	}

	srv, err := api.New(api.Config{
		Origin: cfg.origin,
		RPID:   cfg.rpID,
		RPName: cfg.rpName,
		Static: web.Handler(),
		Logger: logger,

		ClientIPHeader: cfg.clientIPHeader,
		Downloads:      cfg.downloads,
		DownloadsRepo:  cfg.downloadsRepo,
		Billing:        bill,
	}, st, keys)
	if err != nil {
		return err
	}

	maintCtx, cancelMaint := context.WithCancel(context.Background())
	defer cancelMaint()
	go srv.RunMaintenance(maintCtx)

	httpSrv := &http.Server{
		Addr:              cfg.addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return err
	}
	logger.Info("journal listening", "database", st.Dialect(), "addr", ln.Addr().String(), "origin", srv.Origin(), "rpId", cfg.rpID, "data", cfg.data)

	errCh := make(chan error, 2)
	go func() { errCh <- httpSrv.Serve(ln) }()

	var metricsSrv *http.Server
	if cfg.metricsAddr != "" {
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", srv.MetricsHandler())
		metricsSrv = &http.Server{Addr: cfg.metricsAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		mln, err := net.Listen("tcp", cfg.metricsAddr)
		if err != nil {
			return fmt.Errorf("metrics listener: %w", err)
		}
		logger.Info("metrics listening", "addr", mln.Addr().String())
		go func() { errCh <- metricsSrv.Serve(mln) }()
	}

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if metricsSrv != nil {
		_ = metricsSrv.Shutdown(shutdownCtx)
	}
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

// prepareDataDir creates the data directory if needed and makes it private:
// MkdirAll leaves the mode of an existing directory (e.g. one made by `mkdir -p`)
// untouched, and the database holds wrapped keys and every user's ciphertext.
func prepareDataDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("restrict data dir permissions: %w", err)
	}
	return nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}
