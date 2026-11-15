// Package billing is a small Stripe client: just the calls Kagimo needs for a single
// yearly subscription (customers, a price, Checkout, the customer portal, subscription
// lookups) and webhook signature verification. It talks to the REST API directly so the
// server keeps its short dependency list.
//
// Stripe only ever learns a Kagimo user id (in customer metadata) and whatever the
// customer types into Stripe Checkout. No username, journal content or key material is sent.
package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// APIVersion pins the Stripe API version so response shapes don't change under us.
const APIVersion = "2025-03-31.basil"

const defaultBaseURL = "https://api.stripe.com"

// Plan is one price of the subscription Kagimo sells (monthly or yearly).
type Plan struct {
	Amount   int64  // in the currency's smallest unit, e.g. 1000 = $10.00
	Currency string // ISO code, lower case, e.g. "usd"
	Interval string // "year" or "month"
	Product  string // product name shown in Checkout and on receipts
}

// LookupKey identifies the Stripe price for this plan. Changing the amount, currency or
// interval yields a new key, so a new price is created and existing subscribers stay on
// theirs until they resubscribe.
func (p Plan) LookupKey() string {
	return fmt.Sprintf("kagimo_%s_%s_%d", p.Interval, p.Currency, p.Amount)
}

// Client calls the Stripe API with a secret key.
type Client struct {
	key     string
	plans   []Plan
	baseURL string
	http    *http.Client

	mu       sync.Mutex
	priceIDs map[string]string // by interval
	portalID string
}

// New returns a client. baseURL may be empty (the real API); tests point it at a fake.
// plans holds at most one price per interval, in the order they are offered.
func New(secretKey string, plans []Plan, baseURL string) *Client {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	return &Client{
		key:      secretKey,
		plans:    plans,
		baseURL:  strings.TrimRight(baseURL, "/"),
		http:     &http.Client{Timeout: 20 * time.Second},
		priceIDs: map[string]string{},
	}
}

// Plans returns the configured prices.
func (c *Client) Plans() []Plan { return c.plans }

// PlanFor returns the price billed every interval ("month" or "year").
func (c *Client) PlanFor(interval string) (Plan, bool) {
	for _, p := range c.plans {
		if p.Interval == interval {
			return p, true
		}
	}
	return Plan{}, false
}

// Error is an error response from Stripe.
type Error struct {
	Status  int
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("stripe %d %s: %s", e.Status, e.Type, e.Message)
}

// call sends a form-encoded request and decodes the JSON response into out.
func (c *Client) call(ctx context.Context, method, path string, form url.Values, idempotencyKey string, out any) error {
	var body io.Reader
	target := c.baseURL + path
	if method == http.MethodGet {
		if len(form) > 0 {
			target += "?" + form.Encode()
		}
	} else {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.key, "")
	req.Header.Set("Stripe-Version", APIVersion)
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("stripe %s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("stripe %s %s: %w", method, path, err)
	}
	if res.StatusCode >= 300 {
		var wrap struct {
			Error Error `json:"error"`
		}
		_ = json.Unmarshal(data, &wrap)
		wrap.Error.Status = res.StatusCode
		if wrap.Error.Message == "" {
			wrap.Error.Message = http.StatusText(res.StatusCode)
		}
		return &wrap.Error
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("stripe %s %s: decode: %w", method, path, err)
	}
	return nil
}

// CreateCustomer creates a Stripe customer for a Kagimo user. The idempotency key makes
// concurrent first checkouts for the same user return the same customer.
func (c *Client) CreateCustomer(ctx context.Context, userID string) (string, error) {
	form := url.Values{}
	form.Set("metadata[kagimo_user_id]", userID)
	var out struct {
		ID string `json:"id"`
	}
	if err := c.call(ctx, http.MethodPost, "/v1/customers", form, "kagimo-customer-"+userID, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

// PriceID returns the Stripe price for the interval's plan. On first use it looks up every
// configured plan's price by lookup key and creates the missing ones, all on one product so
// the customer portal and receipts show a single subscription. The result is cached.
func (c *Client) PriceID(ctx context.Context, interval string) (string, error) {
	if _, ok := c.PlanFor(interval); !ok {
		return "", fmt.Errorf("no %q plan configured", interval)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if id := c.priceIDs[interval]; id != "" {
		return id, nil
	}
	q := url.Values{}
	for _, p := range c.plans {
		q.Add("lookup_keys[]", p.LookupKey())
	}
	q.Set("active", "true")
	q.Set("limit", "10")
	var list struct {
		Data []struct {
			ID        string `json:"id"`
			LookupKey string `json:"lookup_key"`
			Product   string `json:"product"`
		} `json:"data"`
	}
	if err := c.call(ctx, http.MethodGet, "/v1/prices", q, "", &list); err != nil {
		return "", err
	}
	product := ""
	for _, p := range c.plans {
		for _, d := range list.Data {
			if d.LookupKey == p.LookupKey() {
				c.priceIDs[p.Interval] = d.ID
				product = d.Product
			}
		}
	}
	for _, p := range c.plans {
		if c.priceIDs[p.Interval] != "" {
			continue
		}
		form := url.Values{}
		form.Set("currency", p.Currency)
		form.Set("unit_amount", strconv.FormatInt(p.Amount, 10))
		form.Set("recurring[interval]", p.Interval)
		form.Set("lookup_key", p.LookupKey())
		if product != "" {
			form.Set("product", product)
		} else {
			form.Set("product_data[name]", p.Product)
		}
		var price struct {
			ID      string `json:"id"`
			Product string `json:"product"`
		}
		if err := c.call(ctx, http.MethodPost, "/v1/prices", form, "kagimo-price-"+p.LookupKey()+"-"+product, &price); err != nil {
			return "", err
		}
		c.priceIDs[p.Interval] = price.ID
		if product == "" {
			product = price.Product
		}
	}
	return c.priceIDs[interval], nil
}

// CheckoutParams are the inputs of a subscription Checkout Session.
type CheckoutParams struct {
	Interval   string // which plan: "month" or "year"
	Customer   string
	UserID     string
	SuccessURL string
	CancelURL  string
}

// CheckoutSession is what the app needs to show Checkout: the URL of Stripe's hosted page.
// Checkout is only ever hosted (a redirect to stripe.com): the embedded form would need
// Stripe's script inside the app's own origin, next to the journal's keys.
type CheckoutSession struct {
	URL string `json:"url"`
}

// CreateCheckoutSession starts a Checkout for the plan.
func (c *Client) CreateCheckoutSession(ctx context.Context, p CheckoutParams) (CheckoutSession, error) {
	var out CheckoutSession
	price, err := c.PriceID(ctx, p.Interval)
	if err != nil {
		return out, err
	}
	form := url.Values{}
	form.Set("mode", "subscription")
	form.Set("customer", p.Customer)
	form.Set("client_reference_id", p.UserID)
	form.Set("line_items[0][price]", price)
	form.Set("line_items[0][quantity]", "1")
	form.Set("success_url", p.SuccessURL)
	form.Set("cancel_url", p.CancelURL)
	form.Set("allow_promotion_codes", "true")
	form.Set("subscription_data[metadata][kagimo_user_id]", p.UserID)
	if err := c.call(ctx, http.MethodPost, "/v1/checkout/sessions", form, "", &out); err != nil {
		return CheckoutSession{}, err
	}
	return out, nil
}

// portalConfiguration returns a customer-portal configuration, creating one if the
// account has none (a fresh Stripe account has no default until one is saved).
func (c *Client) portalConfiguration(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.portalID != "" {
		return c.portalID, nil
	}
	q := url.Values{}
	q.Set("active", "true")
	q.Set("limit", "10")
	var list struct {
		Data []struct {
			ID        string `json:"id"`
			IsDefault bool   `json:"is_default"`
		} `json:"data"`
	}
	if err := c.call(ctx, http.MethodGet, "/v1/billing_portal/configurations", q, "", &list); err != nil {
		return "", err
	}
	for _, cfg := range list.Data {
		if cfg.IsDefault {
			c.portalID = cfg.ID
			return c.portalID, nil
		}
	}
	if len(list.Data) > 0 {
		c.portalID = list.Data[0].ID
		return c.portalID, nil
	}
	form := url.Values{}
	form.Set("business_profile[headline]", c.plans[0].Product+" subscription")
	form.Set("features[invoice_history][enabled]", "true")
	form.Set("features[payment_method_update][enabled]", "true")
	form.Set("features[customer_update][enabled]", "true")
	form.Add("features[customer_update][allowed_updates][]", "email")
	form.Add("features[customer_update][allowed_updates][]", "address")
	form.Set("features[subscription_cancel][enabled]", "true")
	form.Set("features[subscription_cancel][mode]", "at_period_end")
	var cfg struct {
		ID string `json:"id"`
	}
	if err := c.call(ctx, http.MethodPost, "/v1/billing_portal/configurations", form, "kagimo-portal-config-v1", &cfg); err != nil {
		return "", err
	}
	c.portalID = cfg.ID
	return c.portalID, nil
}

// CreatePortalSession returns a URL to Stripe's customer portal (update card, cancel,
// download invoices).
func (c *Client) CreatePortalSession(ctx context.Context, customer, returnURL string) (string, error) {
	cfg, err := c.portalConfiguration(ctx)
	if err != nil {
		return "", err
	}
	form := url.Values{}
	form.Set("customer", customer)
	form.Set("return_url", returnURL)
	form.Set("configuration", cfg)
	var out struct {
		URL string `json:"url"`
	}
	if err := c.call(ctx, http.MethodPost, "/v1/billing_portal/sessions", form, "", &out); err != nil {
		return "", err
	}
	return out.URL, nil
}

// Subscription is the part of a Stripe subscription Kagimo cares about.
type Subscription struct {
	ID                string
	Status            string
	CurrentPeriodEnd  time.Time
	CancelAtPeriodEnd bool
}

// Entitles reports whether a subscription in this status should unlock the paid plan.
// past_due keeps access while Stripe retries the renewal payment.
func (s Subscription) Entitles() bool {
	switch s.Status {
	case "active", "trialing", "past_due":
		return true
	}
	return false
}

type subscriptionJSON struct {
	ID                string `json:"id"`
	Status            string `json:"status"`
	CancelAtPeriodEnd bool   `json:"cancel_at_period_end"`
	// Before API version 2025-03-31 the period lived on the subscription; since then it is
	// on each item. Both are read so either shape works.
	CurrentPeriodEnd int64 `json:"current_period_end"`
	Items            struct {
		Data []struct {
			CurrentPeriodEnd int64 `json:"current_period_end"`
		} `json:"data"`
	} `json:"items"`
}

func (s subscriptionJSON) toSubscription() Subscription {
	end := s.CurrentPeriodEnd
	for _, it := range s.Items.Data {
		if it.CurrentPeriodEnd > end {
			end = it.CurrentPeriodEnd
		}
	}
	var t time.Time
	if end > 0 {
		t = time.Unix(end, 0).UTC()
	}
	return Subscription{ID: s.ID, Status: s.Status, CurrentPeriodEnd: t, CancelAtPeriodEnd: s.CancelAtPeriodEnd}
}

// Subscriptions lists the customer's subscriptions in every status.
func (c *Client) Subscriptions(ctx context.Context, customer string) ([]Subscription, error) {
	q := url.Values{}
	q.Set("customer", customer)
	q.Set("status", "all")
	q.Set("limit", "20")
	var list struct {
		Data []subscriptionJSON `json:"data"`
	}
	if err := c.call(ctx, http.MethodGet, "/v1/subscriptions", q, "", &list); err != nil {
		return nil, err
	}
	out := make([]Subscription, 0, len(list.Data))
	for _, s := range list.Data {
		out = append(out, s.toSubscription())
	}
	return out, nil
}

// Ended reports whether the subscription is over for good, so there is nothing to cancel.
func (s Subscription) Ended() bool {
	return s.Status == "canceled" || s.Status == "incomplete_expired"
}

// CancelSubscription cancels a subscription immediately: no further invoices are raised.
func (c *Client) CancelSubscription(ctx context.Context, id string) error {
	return c.call(ctx, http.MethodDelete, "/v1/subscriptions/"+url.PathEscape(id), nil, "", nil)
}

// CancelSubscriptions cancels every subscription of the customer that has not already
// ended, and returns how many it cancelled. It keeps going past a failure and returns the
// first one.
func (c *Client) CancelSubscriptions(ctx context.Context, customer string) (int, error) {
	subs, err := c.Subscriptions(ctx, customer)
	if err != nil {
		return 0, err
	}
	var (
		n     int
		first error
	)
	for _, s := range subs {
		if s.Ended() {
			continue
		}
		if err := c.CancelSubscription(ctx, s.ID); err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		n++
	}
	return n, first
}

// Best picks the subscription that decides the customer's plan: the entitling one that
// runs longest, else the most recently ending one. ok is false if there are none.
func Best(subs []Subscription) (best Subscription, ok bool) {
	for _, s := range subs {
		switch {
		case !ok:
			best, ok = s, true
		case s.Entitles() && !best.Entitles():
			best = s
		case s.Entitles() == best.Entitles() && s.CurrentPeriodEnd.After(best.CurrentPeriodEnd):
			best = s
		}
	}
	return best, ok
}

// --- webhooks ---

// Event is a verified webhook event. Only the fields used to find the customer are decoded:
// the server re-reads the customer's subscriptions from the API rather than trusting the
// order or content of events.
type Event struct {
	ID       string
	Type     string
	Customer string
}

// ErrBadSignature is returned for a webhook whose signature doesn't verify.
var ErrBadSignature = errors.New("invalid stripe webhook signature")

// webhookTolerance is how old a signed webhook may be (Stripe's own default).
const webhookTolerance = 5 * time.Minute

// ParseWebhook verifies the Stripe-Signature header against the endpoint secret and
// decodes the event. See https://docs.stripe.com/webhooks#verify-manually.
func ParseWebhook(payload []byte, sigHeader, secret string, now time.Time) (*Event, error) {
	var (
		timestamp int64
		sigs      [][]byte
	)
	for _, part := range strings.Split(sigHeader, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			t, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				return nil, ErrBadSignature
			}
			timestamp = t
		case "v1":
			if b, err := hex.DecodeString(v); err == nil {
				sigs = append(sigs, b)
			}
		}
	}
	if timestamp == 0 || len(sigs) == 0 {
		return nil, ErrBadSignature
	}
	signedAt := time.Unix(timestamp, 0)
	if d := now.Sub(signedAt); d > webhookTolerance || d < -webhookTolerance {
		return nil, ErrBadSignature
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(timestamp, 10)))
	mac.Write([]byte("."))
	mac.Write(payload)
	want := mac.Sum(nil)
	valid := false
	for _, s := range sigs {
		if hmac.Equal(s, want) {
			valid = true
		}
	}
	if !valid {
		return nil, ErrBadSignature
	}

	var raw struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Data struct {
			Object json.RawMessage `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, fmt.Errorf("decode stripe event: %w", err)
	}
	ev := &Event{ID: raw.ID, Type: raw.Type}
	// Subscriptions, invoices and checkout sessions carry the customer id as "customer";
	// customer objects carry it as "id".
	var obj struct {
		Object   string          `json:"object"`
		ID       string          `json:"id"`
		Customer json.RawMessage `json:"customer"`
	}
	if err := json.Unmarshal(raw.Data.Object, &obj); err == nil {
		if obj.Object == "customer" {
			ev.Customer = obj.ID
		} else {
			var id string
			if json.Unmarshal(obj.Customer, &id) == nil {
				ev.Customer = id
			} else {
				var expanded struct {
					ID string `json:"id"`
				}
				if json.Unmarshal(obj.Customer, &expanded) == nil {
					ev.Customer = expanded.ID
				}
			}
		}
	}
	return ev, nil
}

// SignForTest builds a Stripe-Signature header (for tests and local tooling).
func SignForTest(payload []byte, secret string, at time.Time) string {
	mac := hmac.New(sha256.New, []byte(secret))
	ts := strconv.FormatInt(at.Unix(), 10)
	mac.Write([]byte(ts + "."))
	mac.Write(payload)
	return "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}
