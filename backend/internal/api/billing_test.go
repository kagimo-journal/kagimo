package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"journal/internal/billing"
	"journal/internal/store"
)

// fakeStripe is a minimal stand-in for the Stripe API.
type fakeStripe struct {
	mu        sync.Mutex
	customers int
	prices    map[string]string // lookup key → price id
	products  int
	subs      map[string][]map[string]any // customer → subscription objects
	forms     []string                    // every request body/query seen, to check nothing private leaks
	cancelled []string                    // subscription ids cancelled, in order
	// failCancel makes DELETE /v1/subscriptions/{id} answer 500.
	failCancel bool
}

func newFakeStripe(t *testing.T) (*fakeStripe, *httptest.Server) {
	f := &fakeStripe{subs: map[string][]map[string]any{}, prices: map[string]string{}}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if u, _, ok := r.BasicAuth(); !ok || u != "sk_test_fake" {
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("Stripe-Version") != billing.APIVersion {
			t.Errorf("Stripe-Version = %q", r.Header.Get("Stripe-Version"))
		}
		_ = r.ParseForm()
		f.forms = append(f.forms, r.Form.Encode())
		out := map[string]any{}
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/customers":
			f.customers++
			out["id"] = fmt.Sprintf("cus_%d", f.customers)
		case "GET /v1/prices":
			data := []any{}
			for _, k := range r.Form["lookup_keys[]"] {
				if id := f.prices[k]; id != "" {
					data = append(data, map[string]any{"id": id, "lookup_key": k, "product": "prod_1"})
				}
			}
			out["data"] = data
		case "POST /v1/prices":
			want := map[string]string{"month": "500", "year": "4000"}[r.Form.Get("recurring[interval]")]
			if want == "" || r.Form.Get("unit_amount") != want || r.Form.Get("currency") != "aud" {
				t.Errorf("unexpected price form %v", r.Form)
			}
			// The first price creates the product; the second joins it.
			if r.Form.Get("product") == "" {
				f.products++
			} else if r.Form.Get("product") != "prod_1" {
				t.Errorf("price on product %q", r.Form.Get("product"))
			}
			id := "price_" + r.Form.Get("recurring[interval]")
			f.prices[r.Form.Get("lookup_key")] = id
			out["id"], out["product"] = id, "prod_1"
		case "POST /v1/checkout/sessions":
			if r.Form.Get("mode") != "subscription" || !strings.HasPrefix(r.Form.Get("line_items[0][price]"), "price_") {
				t.Errorf("unexpected checkout form %v", r.Form)
			}
			if r.Form.Get("ui_mode") != "" || r.Form.Get("success_url") == "" || r.Form.Get("cancel_url") == "" {
				t.Errorf("checkout must be the hosted page with return URLs: %v", r.Form)
			}
			out["url"] = "https://checkout.stripe.test/c/" + r.Form.Get("customer") + "/" + r.Form.Get("line_items[0][price]")
		case "GET /v1/billing_portal/configurations":
			out["data"] = []any{}
		case "POST /v1/billing_portal/configurations":
			out["id"] = "bpc_1"
		case "POST /v1/billing_portal/sessions":
			out["url"] = "https://billing.stripe.test/p/" + r.Form.Get("customer")
		case "GET /v1/subscriptions":
			data := f.subs[r.Form.Get("customer")]
			if data == nil {
				data = []map[string]any{}
			}
			out["data"] = data
		default:
			if id, ok := strings.CutPrefix(r.URL.Path, "/v1/subscriptions/"); ok && r.Method == http.MethodDelete {
				if f.failCancel {
					w.WriteHeader(500)
					out["error"] = map[string]any{"type": "api_error", "message": "try again"}
					break
				}
				f.cancelled = append(f.cancelled, id)
				for _, subs := range f.subs {
					for _, sub := range subs {
						if sub["id"] == id {
							sub["status"] = "canceled"
						}
					}
				}
				out["id"], out["status"] = id, "canceled"
				break
			}
			w.WriteHeader(404)
			out["error"] = map[string]any{"type": "invalid_request_error", "message": "no route " + r.URL.Path}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(ts.Close)
	return f, ts
}

func (f *fakeStripe) setSub(customer, status string, periodEnd time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Basil-style shape: the period lives on the items.
	f.subs[customer] = []map[string]any{{
		"id": "sub_1", "status": status, "cancel_at_period_end": false,
		"items": map[string]any{"data": []any{map[string]any{"current_period_end": periodEnd.Unix()}}},
	}}
}

const testWebhookSecret = "whsec_test"

// Each createEntry stores 2×12 bytes of nonce + 32 + 64 of ciphertext = 120 bytes, so five fit.
const (
	testEntryBytes = 120
	testFreeBytes  = 5 * testEntryBytes
	testPaidBytes  = 8 * testEntryBytes
)

func newBillingEnv(t *testing.T) (*testEnv, *fakeStripe) {
	f, fts := newFakeStripe(t)
	env := newEnv(t, func(c *Config) {
		c.Billing = BillingConfig{
			Stripe: billing.New("sk_test_fake", []billing.Plan{
				{Amount: 500, Currency: "aud", Interval: "month", Product: "Kagimo"},
				{Amount: 4000, Currency: "aud", Interval: "year", Product: "Kagimo"},
			}, fts.URL),
			WebhookSecret: testWebhookSecret,
			FreeBytes:     testFreeBytes,
			// One day, so tests can pass it without outliving their 30-day sessions.
			FreeDays:  1,
			PaidBytes: testPaidBytes,
		}
	})
	return env, f
}

func createEntry(a *account) resp {
	return a.c.do("POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(32), "body": sealed(64)})
}

func billingOf(t *testing.T, a *account) map[string]any {
	t.Helper()
	return a.c.mustStatus(200, "GET", "/api/me", nil).json(t)["billing"].(map[string]any)
}

func TestBillingOffMeansNoLimit(t *testing.T) {
	env := newEnv(t)
	env.activeUser("admin")
	a := env.activeUser("alice")
	for i := 0; i < 8; i++ {
		if r := createEntry(a); r.status != 200 {
			t.Fatalf("entry %d: %d %s", i, r.status, r.body)
		}
	}
	b := billingOf(t, a)
	if b["enabled"] != false || b["plan"] != "unlimited" || b["full"] != false || b["usedBytes"].(float64) != 8*testEntryBytes {
		t.Fatalf("billing = %v", b)
	}
	// Sign-up never waits for approval.
	if s := env.signupStatus("bob"); s != "active" {
		t.Fatalf("status = %s", s)
	}
}

func (e *testEnv) signupStatus(username string) string {
	e.signup(username)
	u, err := e.st.UserByUsername(context.Background(), username)
	if err != nil {
		e.t.Fatal(err)
	}
	return u.Status
}

func TestSignupIsActiveWithBilling(t *testing.T) {
	env, _ := newBillingEnv(t)
	env.activeUser("admin")
	if s := env.signupStatus("bob"); s != "active" {
		t.Fatalf("status = %s", s)
	}
	// Still no journal access before a second factor.
	env.client().mustStatus(401, "GET", "/api/entries", nil)
	cfg := env.client().mustStatus(200, "GET", "/api/config", nil).json(t)
	bill := cfg["billing"].(map[string]any)
	prices := bill["prices"].([]any)
	if cfg["openSignup"] != nil || len(prices) != 2 || bill["paidBytes"] != float64(testPaidBytes) {
		t.Fatalf("config = %v", cfg)
	}
	if m := prices[0].(map[string]any); m["interval"] != "month" || m["amount"] != float64(500) || m["currency"] != "aud" {
		t.Fatalf("monthly price = %v", m)
	}
}

func TestFreePeriodEnds(t *testing.T) {
	env, _ := newBillingEnv(t)
	env.activeUser("admin")
	a := env.activeUser("alice")

	createEntry(a)
	b := billingOf(t, a)
	if b["freeOver"] != false || b["full"] != false || b["freeUntil"] == nil {
		t.Fatalf("during the free day: %v", b)
	}

	env.clock.Advance(25 * time.Hour)
	b = billingOf(t, a)
	if b["freeOver"] != true || b["full"] != true || b["limitBytes"].(float64) != 0 {
		t.Fatalf("after the free day: %v", b)
	}
	// Well under the size cap, but the period is over: nothing new is taken.
	r := createEntry(a)
	if body := r.json(t); r.status != 402 || r.errCode() != "storage_full" || body["freeOver"] != true {
		t.Fatalf("entry after the free day: %d %s", r.status, r.body)
	}
	// Reads and deletions still work.
	list := a.c.mustStatus(200, "GET", "/api/entries", nil)
	var entries []map[string]any
	_ = json.Unmarshal(list.body, &entries)
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	a.c.mustStatus(200, "DELETE", "/api/entries/"+entries[0]["id"].(string), nil)
}

func TestFreeLimitThenSubscribe(t *testing.T) {
	env, f := newBillingEnv(t)
	admin := env.activeUser("admin")
	a := env.activeUser("alice")

	for i := 0; i < 5; i++ {
		a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(32), "body": sealed(64)})
	}
	r := createEntry(a)
	body := r.json(t)
	if r.status != 402 || r.errCode() != "storage_full" || body["freeBytes"].(float64) != testFreeBytes || body["usedBytes"].(float64) != testFreeBytes {
		t.Fatalf("6th entry: %d %s", r.status, r.body)
	}
	b := billingOf(t, a)
	if b["plan"] != "free" || b["full"] != true || b["usedBytes"].(float64) != testFreeBytes || b["freeBytes"].(float64) != testFreeBytes {
		t.Fatalf("billing = %v", b)
	}

	// Full: growing an entry or adding an image is refused; same-size edits go through.
	list := a.c.mustStatus(200, "GET", "/api/entries", nil)
	var entries []map[string]any
	_ = json.Unmarshal(list.body, &entries)
	id := entries[0]["id"].(string)
	if r := a.c.do("PUT", "/api/entries/"+id, map[string]any{"header": sealed(32), "body": sealed(65), "baseVersion": 1}); r.errCode() != "storage_full" {
		t.Fatalf("growing edit: %d %s", r.status, r.body)
	}
	a.c.mustStatus(200, "PUT", "/api/entries/"+id, map[string]any{"header": sealed(32), "body": sealed(64), "baseVersion": 1})
	// Deleting frees space for something new.
	a.c.mustStatus(200, "DELETE", "/api/entries/"+entries[1]["id"].(string), nil)
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(32), "body": sealed(64)})
	if r := createEntry(a); r.status != 402 {
		t.Fatalf("full again: %d", r.status)
	}

	// Admins are never limited.
	for i := 0; i < 6; i++ {
		admin.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(32), "body": sealed(64)})
	}

	// Checkout creates a customer (once) and both prices on one product (once). Without an
	// interval it uses the first plan.
	co := a.c.mustStatus(200, "POST", "/api/billing/checkout", nil).json(t)
	if co["url"] != "https://checkout.stripe.test/c/cus_1/price_month" {
		t.Fatalf("checkout = %v", co)
	}
	co = a.c.mustStatus(200, "POST", "/api/billing/checkout", map[string]any{"interval": "year"}).json(t)
	if co["url"] != "https://checkout.stripe.test/c/cus_1/price_year" {
		t.Fatalf("yearly checkout = %v", co)
	}
	// Embedded Checkout is gone: an app from before asks in vain.
	if r := a.c.do("POST", "/api/billing/checkout", map[string]any{"interval": "year", "embedded": true}); r.status != 400 || r.errCode() != "embedded_disabled" {
		t.Fatalf("embedded checkout: %d %s", r.status, r.body)
	}
	if r := a.c.do("POST", "/api/billing/checkout", map[string]any{"interval": "week"}); r.errCode() != "bad_interval" {
		t.Fatalf("weekly checkout: %d %s", r.status, r.body)
	}
	if f.customers != 1 || len(f.prices) != 2 || f.products != 1 {
		t.Fatalf("customers=%d prices=%v products=%d", f.customers, f.prices, f.products)
	}
	// Stripe only ever sees the user id, never the username.
	for _, form := range f.forms {
		if strings.Contains(form, "alice") {
			t.Fatalf("username sent to Stripe: %s", form)
		}
	}

	// Not paid yet: sync changes nothing.
	if b := a.c.mustStatus(200, "POST", "/api/billing/sync", nil).json(t); b["plan"] != "free" {
		t.Fatalf("sync before payment = %v", b)
	}
	// Payment completes; the app's sync picks it up. (A short period keeps the test inside
	// the 30-day session lifetime.)
	f.setSub("cus_1", "active", env.clock.Now().Add(10*24*time.Hour))
	b = a.c.mustStatus(200, "POST", "/api/billing/sync", nil).json(t)
	if b["plan"] != "subscribed" || b["full"] != false || b["status"] != "active" {
		t.Fatalf("sync after payment = %v", b)
	}
	if b["limitBytes"] != float64(testPaidBytes) {
		t.Fatalf("paid limit = %v", b["limitBytes"])
	}
	// Paid accounts have a fair-use cap: past it, writes get 413 storage_limit (no paywall).
	for i := 0; i < 3; i++ {
		a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(32), "body": sealed(64)})
	}
	if r := createEntry(a); r.status != 413 || r.errCode() != "storage_limit" {
		t.Fatalf("over fair-use cap: %d %s", r.status, r.body)
	}
	if r := a.c.do("POST", "/api/billing/checkout", nil); r.errCode() != "already_subscribed" {
		t.Fatalf("checkout while subscribed: %d %s", r.status, r.body)
	}

	// The portal works once there's a customer.
	p := a.c.mustStatus(200, "POST", "/api/billing/portal", nil).json(t)
	if p["url"] != "https://billing.stripe.test/p/cus_1" {
		t.Fatalf("portal = %v", p)
	}

	// The period ends without renewal: limited again after the grace period.
	env.clock.Advance(10*24*time.Hour + subscriptionGrace + time.Hour)
	if r := createEntry(a); r.status != 402 {
		t.Fatalf("after expiry: %d", r.status)
	}
}

func TestPortalNeedsCustomer(t *testing.T) {
	env, _ := newBillingEnv(t)
	env.activeUser("admin")
	a := env.activeUser("alice")
	if r := a.c.do("POST", "/api/billing/portal", nil); r.errCode() != "no_subscription" {
		t.Fatalf("portal without customer: %d %s", r.status, r.body)
	}
}

func TestAdminComp(t *testing.T) {
	env, _ := newBillingEnv(t)
	admin := env.activeUser("admin")
	a := env.activeUser("alice")
	id := env.userID("alice")
	admin.c.mustStatus(200, "POST", "/api/admin/users/"+id+"/comp", nil)
	for i := 0; i < 7; i++ {
		a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(32), "body": sealed(64)})
	}
	if b := billingOf(t, a); b["plan"] != "comped" {
		t.Fatalf("billing = %v", b)
	}
	admin.c.mustStatus(200, "POST", "/api/admin/users/"+id+"/uncomp", nil)
	if r := createEntry(a); r.status != 402 {
		t.Fatalf("after uncomp: %d", r.status)
	}
	// Members can't comp themselves.
	a.c.mustStatus(403, "POST", "/api/admin/users/"+id+"/comp", nil)
}

func webhookBody(customer string) []byte {
	b, _ := json.Marshal(map[string]any{
		"id": "evt_1", "type": "customer.subscription.updated",
		"data": map[string]any{"object": map[string]any{"object": "subscription", "id": "sub_1", "customer": customer}},
	})
	return b
}

func TestWebhook(t *testing.T) {
	env, f := newBillingEnv(t)
	env.activeUser("admin")
	a := env.activeUser("alice")
	a.c.mustStatus(200, "POST", "/api/billing/checkout", nil)
	f.setSub("cus_1", "active", env.clock.Now().Add(365*24*time.Hour))

	post := func(body []byte, sig string) resp {
		// Stripe sends neither X-Journal nor Origin.
		return env.client().raw("POST", "/api/billing/webhook", bytes.NewReader(body), "application/json",
			withoutCSRF(), withHeader("Stripe-Signature", sig))
	}
	body := webhookBody("cus_1")
	if r := post(body, "t=1,v1=00"); r.status != 400 {
		t.Fatalf("bad signature: %d %s", r.status, r.body)
	}
	if r := post(body, billing.SignForTest(body, "wrong", env.clock.Now())); r.status != 400 {
		t.Fatalf("wrong secret: %d", r.status)
	}
	if r := post(body, billing.SignForTest(body, testWebhookSecret, env.clock.Now().Add(-time.Hour))); r.status != 400 {
		t.Fatalf("stale signature: %d", r.status)
	}
	if b := billingOf(t, a); b["plan"] != "free" {
		t.Fatalf("plan changed by rejected webhooks: %v", b)
	}
	if r := post(body, billing.SignForTest(body, testWebhookSecret, env.clock.Now())); r.status != 200 {
		t.Fatalf("valid webhook: %d %s", r.status, r.body)
	}
	if b := billingOf(t, a); b["plan"] != "subscribed" {
		t.Fatalf("plan after webhook = %v", b)
	}
	// Unknown customers are acknowledged so Stripe stops retrying.
	other := webhookBody("cus_other")
	if r := post(other, billing.SignForTest(other, testWebhookSecret, env.clock.Now())); r.status != 200 {
		t.Fatalf("unknown customer: %d", r.status)
	}
	// Cancellation arrives.
	f.setSub("cus_1", "canceled", env.clock.Now())
	if r := post(body, billing.SignForTest(body, testWebhookSecret, env.clock.Now())); r.status != 200 {
		t.Fatalf("cancel webhook: %d", r.status)
	}
	if b := billingOf(t, a); b["plan"] != "free" {
		t.Fatalf("plan after cancel = %v", b)
	}
}

func TestBillingEndpointsNeedActiveSession(t *testing.T) {
	env, _ := newBillingEnv(t)
	for _, p := range []string{"/api/billing/checkout", "/api/billing/portal", "/api/billing/sync"} {
		env.client().mustStatus(401, "POST", p, nil)
	}
	// Billing off: endpoints say so.
	plain := newEnv(t)
	plain.activeUser("admin")
	a := plain.activeUser("alice")
	if r := a.c.do("POST", "/api/billing/checkout", nil); r.errCode() != "billing_disabled" {
		t.Fatalf("checkout with billing off: %d %s", r.status, r.body)
	}
}

// Stripe's script never runs in the journal's origin: with billing on, the CSP is the same
// as without, the config carries no publishable key, and Checkout is only ever a URL.
func TestBillingNeverAdmitsStripeIntoTheOrigin(t *testing.T) {
	env, _ := newBillingEnv(t)
	env.activeUser("admin")
	a := env.activeUser("alice")

	res := env.client().mustStatus(200, "GET", "/api/config", nil)
	if got := res.header.Get("Content-Security-Policy"); got != csp || strings.Contains(got, "stripe") {
		t.Fatalf("CSP with billing on = %q, want the one policy %q", got, csp)
	}
	plan := res.json(t)["billing"].(map[string]any)
	if plan["enabled"] != true {
		t.Fatalf("billing config = %v", plan)
	}
	if _, has := plan["publishableKey"]; has {
		t.Fatalf("config exposes a publishable key: %v", plan)
	}
	co := a.c.mustStatus(200, "POST", "/api/billing/checkout", map[string]any{"interval": "year"}).json(t)
	if url, _ := co["url"].(string); !strings.HasPrefix(url, "https://checkout.stripe.test/") || len(co) != 1 {
		t.Fatalf("checkout = %v, want only a url", co)
	}
	if got := a.c.mustStatus(200, "GET", "/api/me", nil).header.Get("Content-Security-Policy"); got != csp {
		t.Fatalf("CSP on an authenticated response = %q", got)
	}
}

// Deleting an account cancels its Stripe subscription, so nobody is charged for an account
// that no longer exists. A Stripe failure is logged and does not stop the delete.
func TestAdminDeleteCancelsSubscription(t *testing.T) {
	env, f := newBillingEnv(t)
	admin := env.activeUser("admin")
	customerOf := func(username string) string {
		t.Helper()
		u, err := env.st.UserByUsername(context.Background(), username)
		if err != nil {
			t.Fatal(err)
		}
		return u.StripeCustomerID
	}
	subscribe := func(username string) string {
		t.Helper()
		a := env.activeUser(username)
		a.c.mustStatus(200, "POST", "/api/billing/checkout", nil)
		customer := customerOf(username)
		if customer == "" {
			t.Fatalf("%s has no customer", username)
		}
		f.setSub(customer, "active", env.clock.Now().Add(30*24*time.Hour))
		return customer
	}
	gone := func(username string) {
		t.Helper()
		if _, err := env.st.UserByUsername(context.Background(), username); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("%s still exists: %v", username, err)
		}
	}
	status := func(customer string) any {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.subs[customer][0]["status"]
	}

	// An active subscription is cancelled.
	alice := subscribe("alice")
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+env.userID("alice"), nil)
	gone("alice")
	if len(f.cancelled) != 1 || status(alice) != "canceled" {
		t.Fatalf("cancelled = %v, subscription %v", f.cancelled, status(alice))
	}

	// One that already ended is left alone, as is a customer who never subscribed and an
	// account that never reached Stripe.
	bob := subscribe("bob")
	f.setSub(bob, "canceled", env.clock.Now())
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+env.userID("bob"), nil)
	carol := env.activeUser("carol")
	carol.c.mustStatus(200, "POST", "/api/billing/checkout", nil)
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+env.userID("carol"), nil)
	env.activeUser("dave")
	calls := len(f.forms)
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+env.userID("dave"), nil)
	if len(f.forms) != calls {
		t.Fatalf("deleting an account without a customer called Stripe %d times", len(f.forms)-calls)
	}
	if len(f.cancelled) != 1 {
		t.Fatalf("cancelled = %v, want only alice's", f.cancelled)
	}

	// Stripe failing does not keep the account alive.
	erin := subscribe("erin")
	f.mu.Lock()
	f.failCancel = true
	f.mu.Unlock()
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+env.userID("erin"), nil)
	gone("erin")
	if len(f.cancelled) != 1 || status(erin) != "active" {
		t.Fatalf("cancelled = %v, erin's subscription %v", f.cancelled, status(erin))
	}
}

// With billing off there is no Stripe client: deleting an account just deletes it.
func TestAdminDeleteWithoutBilling(t *testing.T) {
	env := newEnv(t)
	admin := env.activeUser("admin")
	env.activeUser("alice")
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+env.userID("alice"), nil)
}

func signupBody(username, invite string) map[string]any {
	return map[string]any{
		"username": username, "note": "",
		"kdf":     map[string]any{"salt": randB64(16), "m": 65536, "t": 3, "p": 1},
		"authKey": randB64(32), "recoveryAuthKey": randB64(32),
		"wrappedMkPass": sealed(48), "wrappedMkRecovery": sealed(48),
		"invite": invite,
	}
}

func TestInvites(t *testing.T) {
	env, _ := newBillingEnv(t)
	admin := env.activeUser("admin")
	alice := env.activeUser("alice")

	// Only admins mint, list or withdraw.
	alice.c.mustStatus(403, "POST", "/api/admin/invites", map[string]any{})
	alice.c.mustStatus(403, "GET", "/api/admin/invites", nil)

	inv := admin.c.mustStatus(200, "POST", "/api/admin/invites", map[string]any{"note": "for bob"}).json(t)
	code, _ := inv["code"].(string)
	if len(code) != 19 || inv["note"] != "for bob" || inv["usedAt"] != nil {
		t.Fatalf("invite = %v", inv)
	}

	// An unknown code creates nothing.
	if r := env.client().do("POST", "/api/signup", signupBody("bob", "ZZZZ-ZZZZ-ZZZZ-ZZZZ")); r.errCode() != "invalid_invite" {
		t.Fatalf("bad invite: %d %s", r.status, r.body)
	}
	if _, err := env.st.UserByUsername(context.Background(), "bob"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob exists after a bad invite: %v", err)
	}

	// Case and dashes don't matter; the account is comped and never limited.
	bob := env.client()
	r := bob.mustStatus(200, "POST", "/api/signup", signupBody("bob", strings.ToLower(strings.ReplaceAll(code, "-", ""))))
	if b := r.json(t)["me"].(map[string]any)["billing"].(map[string]any); b["plan"] != "comped" {
		t.Fatalf("billing = %v", b)
	}

	// Used once only, and a used invite can't be withdrawn.
	if r := env.client().do("POST", "/api/signup", signupBody("carol", code)); r.errCode() != "invalid_invite" {
		t.Fatalf("reused invite: %d %s", r.status, r.body)
	}
	list := admin.c.mustStatus(200, "GET", "/api/admin/invites", nil)
	var invites []map[string]any
	if err := jsonUnmarshal(list.body, &invites); err != nil || len(invites) != 1 || invites[0]["usedBy"] != "bob" || invites[0]["code"] != nil {
		t.Fatalf("invites = %s", list.body)
	}
	if r := admin.c.do("DELETE", "/api/admin/invites/"+inv["id"].(string), nil); r.errCode() != "invite_used" {
		t.Fatalf("delete used: %d %s", r.status, r.body)
	}

	// Deleting the account doesn't free the code.
	admin.c.mustStatus(200, "DELETE", "/api/admin/users/"+env.userID("bob"), nil)
	if r := env.client().do("POST", "/api/signup", signupBody("dave", code)); r.errCode() != "invalid_invite" {
		t.Fatalf("invite reusable after delete: %d %s", r.status, r.body)
	}

	// An unused invite can be withdrawn, and then doesn't work.
	inv2 := admin.c.mustStatus(200, "POST", "/api/admin/invites", map[string]any{}).json(t)
	admin.c.mustStatus(200, "DELETE", "/api/admin/invites/"+inv2["id"].(string), nil)
	if r := env.client().do("POST", "/api/signup", signupBody("erin", inv2["code"].(string))); r.errCode() != "invalid_invite" {
		t.Fatalf("withdrawn invite: %d %s", r.status, r.body)
	}
	// Without an invite, sign-up is unchanged (free plan).
	r = env.client().mustStatus(200, "POST", "/api/signup", signupBody("frank", ""))
	if b := r.json(t)["me"].(map[string]any)["billing"].(map[string]any); b["plan"] != "free" {
		t.Fatalf("billing = %v", b)
	}
}
