package billing

import (
	"context"
	"os"
	"strings"
	"testing"
)

// TestLiveStripe exercises the client against a real Stripe *test-mode* account. It runs only
// when STRIPE_SECRET_KEY holds an sk_test_ key, e.g.:
//
//	set -a; . ../.env.local; set +a; go test ./internal/billing -run Live -v
func TestLiveStripe(t *testing.T) {
	key := os.Getenv("STRIPE_SECRET_KEY")
	if !strings.HasPrefix(key, "sk_test_") {
		t.Skip("set STRIPE_SECRET_KEY to a test-mode key to run")
	}
	ctx := context.Background()
	c := New(key, []Plan{{Amount: 4000, Currency: "aud", Interval: "year", Product: "Kagimo"}}, "")
	cus, err := c.CreateCustomer(ctx, "live-test-user")
	if err != nil {
		t.Fatal(err)
	}
	price, err := c.PriceID(ctx, "year")
	if err != nil || !strings.HasPrefix(price, "price_") {
		t.Fatalf("price %q: %v", price, err)
	}
	sess, err := c.CreateCheckoutSession(ctx, CheckoutParams{
		Interval: "year",
		Customer: cus, UserID: "live-test-user",
		SuccessURL: "http://localhost:5173/billing/done?result=success", CancelURL: "http://localhost:5173/billing/done?result=cancel",
	})
	if err != nil || !strings.HasPrefix(sess.URL, "https://checkout.stripe.com/") {
		t.Fatalf("checkout %+v: %v", sess, err)
	}
	portal, err := c.CreatePortalSession(ctx, cus, "http://localhost:5173/billing/done?result=portal")
	if err != nil || !strings.HasPrefix(portal, "https://billing.stripe.com/") {
		t.Fatalf("portal %q: %v", portal, err)
	}
	if _, err := c.Subscriptions(ctx, cus); err != nil {
		t.Fatal(err)
	}
	t.Logf("customer %s, price %s, checkout and portal sessions created", cus, price)
}
