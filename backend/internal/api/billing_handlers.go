package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"journal/internal/billing"
	"journal/internal/store"
)

// BillingConfig turns on paid plans. With a nil Stripe client billing is off and nobody
// is limited (self-hosted instances).
type BillingConfig struct {
	Stripe *billing.Client
	// WebhookSecret verifies POST /api/billing/webhook. Without it the endpoint is off and
	// the client's sync calls are the only way subscriptions are picked up.
	WebhookSecret string
	// FreeBytes is how much an account may store on the server without a subscription
	// (entries and settings, as ciphertext). Default DefaultFreeBytes.
	FreeBytes int64
	// FreeDays is how long a new sync account syncs for free, from when it was created,
	// within FreeBytes. Afterwards it takes nothing new until it subscribes. Default
	// DefaultFreeDays.
	FreeDays int
	// PaidBytes is the fair-use cap for subscribed and comped accounts (admins have none).
	// Default DefaultPaidBytes.
	PaidBytes int64
}

// KB and MB are sizes as the app shows them (decimal, like formatBytes in the frontend).
const (
	KB int64 = 1000
	MB int64 = 1000 * KB
)

// DefaultFreeBytes caps the free month: 450 KB, roughly 170 pages of 300 words (about 2.7 KB
// each as ciphertext), far more than a month of daily writing. The landing page shows pages.
const DefaultFreeBytes = 450 * KB

// DefaultFreeDays is the free sync period for a new account.
const DefaultFreeDays = 30

// DefaultPaidBytes is the fair-use cap on paid plans: 100 MB.
const DefaultPaidBytes = 100 * MB

func (b BillingConfig) enabled() bool { return b.Stripe != nil }

// subscriptionGrace keeps access for a few days past the period end, so a renewal that
// Stripe confirms a little late doesn't lock anyone out.
const subscriptionGrace = 3 * 24 * time.Hour

var (
	errBillingOff        = errf(http.StatusNotFound, "billing_disabled", "billing is not enabled on this server")
	errAlreadySubscribed = errf(http.StatusConflict, "already_subscribed", "you already have an active subscription")
	errNoSubscription    = errf(http.StatusConflict, "no_subscription", "there is no subscription to manage yet")
	errBillingProvider   = errf(http.StatusBadGateway, "billing_unavailable", "the payment provider isn't responding, try again shortly")
)

// plan returns which plan the user is on: "unlimited" (billing off), "admin", "comped",
// "subscribed" or "free".
func (s *Server) plan(u *store.User) string {
	switch {
	case !s.cfg.Billing.enabled():
		return "unlimited"
	case u.IsAdmin:
		return "admin"
	case u.Comped:
		return "comped"
	case s.subscribed(u):
		return "subscribed"
	default:
		return "free"
	}
}

// freeUntil is when the account's free sync period ends.
func (s *Server) freeUntil(u *store.User) time.Time {
	return u.CreatedAt.Add(time.Duration(s.cfg.Billing.FreeDays) * 24 * time.Hour)
}

// freeOver reports whether a free account's free sync period has ended.
func (s *Server) freeOver(u *store.User) bool { return !s.cfg.Now().Before(s.freeUntil(u)) }

func (s *Server) subscribed(u *store.User) bool {
	sub := billing.Subscription{Status: u.Sub.Status}
	return sub.Entitles() && s.cfg.Now().Before(u.Sub.PeriodEnd.Add(subscriptionGrace))
}

// storageLimit is the most the user may store on the server, in bytes: the free allowance
// (0 once the free period is over, so nothing grows), the paid fair-use cap, or store.NoLimit
// (billing off, admins).
func (s *Server) storageLimit(u *store.User) int64 {
	switch s.plan(u) {
	case "free":
		if s.freeOver(u) {
			return 0
		}
		return s.cfg.Billing.FreeBytes
	case "subscribed", "comped":
		return s.cfg.Billing.PaidBytes
	}
	return store.NoLimit
}

// quotaErr turns store.ErrQuota into 402 storage_full; other errors pass through.
func (s *Server) quotaErr(ctx context.Context, u *store.User, err error) error {
	if !errors.Is(err, store.ErrQuota) {
		return err
	}
	used, uerr := s.store.UsageBytes(ctx, u.ID)
	if uerr != nil {
		return uerr
	}
	if s.plan(u) != "free" {
		// Paying already: there is nothing to upgrade to, so this isn't a payment error.
		e := errf(http.StatusRequestEntityTooLarge, "storage_limit",
			"you've reached the %s fair-use limit; delete some entries to keep syncing", humanMB(s.cfg.Billing.PaidBytes))
		e.extra = map[string]any{"limitBytes": s.cfg.Billing.PaidBytes, "usedBytes": used}
		return e
	}
	msg := "your free sync space is full; subscribe to keep syncing"
	if s.freeOver(u) {
		msg = "your free sync period is over; subscribe to keep syncing"
	}
	e := errf(http.StatusPaymentRequired, "storage_full", "%s", msg)
	e.extra = map[string]any{"freeBytes": s.cfg.Billing.FreeBytes, "usedBytes": used, "freeOver": s.freeOver(u)}
	return e
}

// humanMB formats a byte count the way the plan is advertised ("20 MB", "10 GB").
func humanMB(n int64) string {
	if n >= 1000*MB && n%(1000*MB) == 0 {
		return fmt.Sprintf("%d GB", n/(1000*MB))
	}
	mb := float64(n) / float64(MB)
	if mb == float64(int64(mb)) {
		return fmt.Sprintf("%d MB", int64(mb))
	}
	return fmt.Sprintf("%.1f MB", mb)
}

type billingJSON struct {
	Enabled bool   `json:"enabled"`
	Plan    string `json:"plan"`
	// FreeBytes is the free plan's storage; UsedBytes what the account stores now.
	FreeBytes int64 `json:"freeBytes"`
	UsedBytes int64 `json:"usedBytes"`
	// LimitBytes is this account's cap right now (FreeBytes, the paid fair-use cap, or -1).
	LimitBytes int64 `json:"limitBytes"`
	// Full: at or over LimitBytes, so the server takes no more.
	Full bool `json:"full"`
	// FreeUntil is when the free sync period ends (or ended); FreeOver says it has. Both
	// describe the free plan and are set for free accounts only.
	FreeUntil         *string `json:"freeUntil"`
	FreeOver          bool    `json:"freeOver"`
	Status            string  `json:"status"`
	PeriodEnd         *string `json:"periodEnd"`
	CancelAtPeriodEnd bool    `json:"cancelAtPeriodEnd"`
	HasCustomer       bool    `json:"hasCustomer"`
}

func (s *Server) buildBilling(ctx context.Context, u *store.User) (billingJSON, error) {
	used, err := s.store.UsageBytes(ctx, u.ID)
	if err != nil {
		return billingJSON{}, err
	}
	b := billingJSON{
		Enabled:           s.cfg.Billing.enabled(),
		Plan:              s.plan(u),
		FreeBytes:         s.cfg.Billing.FreeBytes,
		UsedBytes:         used,
		Status:            u.Sub.Status,
		CancelAtPeriodEnd: u.Sub.CancelAtPeriodEnd,
		HasCustomer:       u.StripeCustomerID != "",
	}
	if !u.Sub.PeriodEnd.IsZero() {
		b.PeriodEnd = tsPtr(&u.Sub.PeriodEnd)
	}
	if b.Plan == "free" {
		until := s.freeUntil(u)
		b.FreeUntil = tsPtr(&until)
		b.FreeOver = s.freeOver(u)
	}
	limit := s.storageLimit(u)
	b.LimitBytes = limit
	b.Full = limit >= 0 && used >= limit
	return b, nil
}

// planJSON describes the price for the sign-up page and the upgrade dialog.
func (s *Server) planJSON() map[string]any {
	if !s.cfg.Billing.enabled() {
		return map[string]any{"enabled": false}
	}
	prices := []map[string]any{}
	for _, p := range s.cfg.Billing.Stripe.Plans() {
		prices = append(prices, map[string]any{"amount": p.Amount, "currency": p.Currency, "interval": p.Interval})
	}
	return map[string]any{
		"enabled":   true,
		"freeBytes": s.cfg.Billing.FreeBytes,
		"freeDays":  s.cfg.Billing.FreeDays,
		"paidBytes": s.cfg.Billing.PaidBytes,
		"prices":    prices,
	}
}

// billingURL builds a URL on this server for Stripe to send the customer back to.
func (s *Server) billingURL(path string) string { return s.cfg.Origin + path }

// ensureCustomer returns the user's Stripe customer id, creating the customer first.
func (s *Server) ensureCustomer(ctx context.Context, u *store.User) (string, error) {
	if u.StripeCustomerID != "" {
		return u.StripeCustomerID, nil
	}
	id, err := s.cfg.Billing.Stripe.CreateCustomer(ctx, u.ID)
	if err != nil {
		return "", s.providerErr(err)
	}
	return s.store.SetStripeCustomer(ctx, u.ID, id)
}

// providerErr logs a Stripe failure and turns it into a client-safe error.
func (s *Server) providerErr(err error) error {
	s.log.Error("stripe", "err", err)
	return errBillingProvider
}

// POST /api/billing/checkout {interval?: "month"|"year"} → {url} for a Stripe Checkout page
// for that plan (the first configured one when omitted). Checkout is always Stripe's hosted
// page, which the app opens in a new tab: Stripe's script is never loaded in the journal's
// origin, and the CSP does not admit it. A request for embedded Checkout (an app loaded
// before that was removed) is refused rather than answered with a URL it wouldn't expect.
func (s *Server) handleBillingCheckout(w http.ResponseWriter, r *http.Request) error {
	if !s.cfg.Billing.enabled() {
		return errBillingOff
	}
	var req struct {
		Interval string `json:"interval"`
		Embedded bool   `json:"embedded"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &req); err != nil {
			return err
		}
	}
	if req.Interval == "" {
		req.Interval = s.cfg.Billing.Stripe.Plans()[0].Interval
	}
	if _, ok := s.cfg.Billing.Stripe.PlanFor(req.Interval); !ok {
		return errf(http.StatusBadRequest, "bad_interval", "there is no %q plan", req.Interval)
	}
	if req.Embedded {
		return errf(http.StatusBadRequest, "embedded_disabled", "embedded checkout is not available; reload the app")
	}
	u := caller(r).user
	if err := s.billingRateLimit(u.ID); err != nil {
		return err
	}
	if p := s.plan(u); p != "free" {
		return errAlreadySubscribed
	}
	customer, err := s.ensureCustomer(r.Context(), u)
	if err != nil {
		return err
	}
	// Re-check with Stripe: a payment may have completed without this server hearing yet.
	if u.StripeCustomerID != "" {
		if fresh, err := s.syncSubscription(r.Context(), u.ID, customer); err == nil && s.plan(fresh) != "free" {
			return errAlreadySubscribed
		}
	}
	session, err := s.cfg.Billing.Stripe.CreateCheckoutSession(r.Context(), billing.CheckoutParams{
		Interval:   req.Interval,
		Customer:   customer,
		UserID:     u.ID,
		SuccessURL: s.billingURL("/billing/done?result=success"),
		CancelURL:  s.billingURL("/billing/done?result=cancel"),
	})
	if err != nil {
		return s.providerErr(err)
	}
	return writeJSON(w, http.StatusOK, map[string]string{"url": session.URL})
}

// POST /api/billing/portal → {url}: Stripe's customer portal (card, invoices, cancel).
func (s *Server) handleBillingPortal(w http.ResponseWriter, r *http.Request) error {
	if !s.cfg.Billing.enabled() {
		return errBillingOff
	}
	u := caller(r).user
	if err := s.billingRateLimit(u.ID); err != nil {
		return err
	}
	if u.StripeCustomerID == "" {
		return errNoSubscription
	}
	url, err := s.cfg.Billing.Stripe.CreatePortalSession(r.Context(), u.StripeCustomerID, s.billingURL("/billing/done?result=portal"))
	if err != nil {
		return s.providerErr(err)
	}
	return writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

// POST /api/billing/sync → billing: re-reads the subscription from Stripe. The app calls it
// while the checkout tab is open, so payments are picked up even without webhooks.
func (s *Server) handleBillingSync(w http.ResponseWriter, r *http.Request) error {
	if !s.cfg.Billing.enabled() {
		return errBillingOff
	}
	u := caller(r).user
	if u.StripeCustomerID != "" {
		if err := s.billingRateLimit(u.ID); err != nil {
			return err
		}
		fresh, err := s.syncSubscription(r.Context(), u.ID, u.StripeCustomerID)
		if err != nil {
			return err
		}
		u = fresh
	}
	b, err := s.buildBilling(r.Context(), u)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, b)
}

// syncSubscription reads the customer's subscriptions from Stripe, stores the one that
// decides the plan and returns the updated user.
func (s *Server) syncSubscription(ctx context.Context, userID, customer string) (*store.User, error) {
	subs, err := s.cfg.Billing.Stripe.Subscriptions(ctx, customer)
	if err != nil {
		return nil, s.providerErr(err)
	}
	var state store.SubscriptionState
	if best, ok := billing.Best(subs); ok {
		state = store.SubscriptionState{Status: best.Status, PeriodEnd: best.CurrentPeriodEnd, CancelAtPeriodEnd: best.CancelAtPeriodEnd}
	}
	if err := s.store.SetSubscription(ctx, userID, state); err != nil {
		return nil, err
	}
	return s.store.UserByID(ctx, userID)
}

// cancelTimeout bounds the Stripe calls made after an account was deleted.
const cancelTimeout = 15 * time.Second

// cancelSubscriptions stops Stripe charging a customer whose account was just deleted. It
// is best effort: the account is already gone, and a failure is logged with the customer
// id so the subscription can be cancelled by hand in the Stripe dashboard.
func (s *Server) cancelSubscriptions(ctx context.Context, userID, customer string) {
	if !s.cfg.Billing.enabled() || customer == "" {
		return
	}
	// The admin closing the page must not stop this half way.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cancelTimeout)
	defer cancel()
	n, err := s.cfg.Billing.Stripe.CancelSubscriptions(ctx, customer)
	if err != nil {
		s.log.Error("stripe: could not cancel the subscription of a deleted account; cancel it in the Stripe dashboard",
			"user", userID, "customer", customer, "cancelled", n, "err", err)
		return
	}
	if n > 0 {
		s.log.Info("stripe: cancelled the subscription of a deleted account", "user", userID, "customer", customer, "cancelled", n)
	}
}

func (s *Server) billingRateLimit(userID string) error {
	if !s.billingLimit.Allow(userID) {
		return errRateLimited
	}
	return nil
}

// maxWebhookBody bounds Stripe event payloads (they are a few KB).
const maxWebhookBody = 512 << 10

// POST /api/billing/webhook: Stripe events. The signature is checked, then the customer's
// subscriptions are re-read from the API, so duplicate or out-of-order events are harmless.
func (s *Server) handleBillingWebhook(w http.ResponseWriter, r *http.Request) error {
	if !s.cfg.Billing.enabled() || s.cfg.Billing.WebhookSecret == "" {
		return errNotFound
	}
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
	if err != nil {
		return errf(http.StatusRequestEntityTooLarge, "too_large", "request body too large")
	}
	ev, err := billing.ParseWebhook(payload, r.Header.Get("Stripe-Signature"), s.cfg.Billing.WebhookSecret, s.cfg.Now())
	if err != nil {
		return errf(http.StatusBadRequest, "bad_signature", "invalid signature")
	}
	if ev.Customer == "" {
		return ok(w)
	}
	u, err := s.store.UserByStripeCustomer(r.Context(), ev.Customer)
	if errors.Is(err, store.ErrNotFound) {
		// Not ours (another product on the same Stripe account), or the user was deleted.
		return ok(w)
	}
	if err != nil {
		return err
	}
	if _, err := s.syncSubscription(r.Context(), u.ID, ev.Customer); err != nil {
		// A 5xx makes Stripe retry the event later.
		return fmt.Errorf("webhook %s %s: %w", ev.Type, ev.ID, err)
	}
	return ok(w)
}
