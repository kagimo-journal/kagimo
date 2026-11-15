package billing

import (
	"encoding/json"
	"testing"
	"time"
)

func TestParseWebhook(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	payload := []byte(`{"id":"evt_1","type":"invoice.paid","data":{"object":{"object":"invoice","customer":"cus_9"}}}`)
	ev, err := ParseWebhook(payload, SignForTest(payload, "whsec", now), "whsec", now)
	if err != nil || ev.Customer != "cus_9" || ev.Type != "invoice.paid" {
		t.Fatalf("ev=%+v err=%v", ev, err)
	}
	// Customer objects carry their own id; expanded customer objects work too.
	cust := []byte(`{"id":"evt_2","type":"customer.deleted","data":{"object":{"object":"customer","id":"cus_7"}}}`)
	if ev, _ := ParseWebhook(cust, SignForTest(cust, "whsec", now), "whsec", now); ev.Customer != "cus_7" {
		t.Fatalf("customer event: %+v", ev)
	}
	exp := []byte(`{"id":"evt_3","type":"x","data":{"object":{"object":"subscription","customer":{"id":"cus_5"}}}}`)
	if ev, _ := ParseWebhook(exp, SignForTest(exp, "whsec", now), "whsec", now); ev.Customer != "cus_5" {
		t.Fatalf("expanded customer: %+v", ev)
	}

	bad := []string{
		"",
		"t=abc,v1=00",
		"v1=" + SignForTest(payload, "whsec", now)[len("t=1800000000,v1="):],
		SignForTest(payload, "other", now),
		SignForTest(payload, "whsec", now.Add(-6*time.Minute)),
		SignForTest(payload, "whsec", now.Add(6*time.Minute)),
	}
	for _, h := range bad {
		if _, err := ParseWebhook(payload, h, "whsec", now); err != ErrBadSignature {
			t.Errorf("header %q: err = %v", h, err)
		}
	}
	// Tampered body.
	sig := SignForTest(payload, "whsec", now)
	if _, err := ParseWebhook(append([]byte{}, append(payload[:len(payload)-1], ' ', '}')...), sig, "whsec", now); err != ErrBadSignature {
		t.Errorf("tampered body accepted")
	}
	// Several v1 signatures (secret rotation): any match is enough.
	if _, err := ParseWebhook(payload, sig+",v1=deadbeef", "whsec", now); err != nil {
		t.Errorf("rotation: %v", err)
	}
}

func TestSubscriptionShapes(t *testing.T) {
	var basil, legacy subscriptionJSON
	_ = json.Unmarshal([]byte(`{"id":"a","status":"active","items":{"data":[{"current_period_end":2000}]}}`), &basil)
	_ = json.Unmarshal([]byte(`{"id":"b","status":"active","current_period_end":3000,"items":{"data":[]}}`), &legacy)
	if got := basil.toSubscription().CurrentPeriodEnd.Unix(); got != 2000 {
		t.Errorf("basil end = %d", got)
	}
	if got := legacy.toSubscription().CurrentPeriodEnd.Unix(); got != 3000 {
		t.Errorf("legacy end = %d", got)
	}
}

func TestBest(t *testing.T) {
	at := func(s int64) time.Time { return time.Unix(s, 0) }
	subs := []Subscription{
		{ID: "old", Status: "canceled", CurrentPeriodEnd: at(500)},
		{ID: "live", Status: "active", CurrentPeriodEnd: at(100)},
		{ID: "incomplete", Status: "incomplete", CurrentPeriodEnd: at(900)},
	}
	if b, ok := Best(subs); !ok || b.ID != "live" {
		t.Fatalf("best = %+v", b)
	}
	if b, _ := Best(subs[:1]); b.ID != "old" {
		t.Fatalf("only canceled = %+v", b)
	}
	if _, ok := Best(nil); ok {
		t.Fatal("best of nothing")
	}
}
