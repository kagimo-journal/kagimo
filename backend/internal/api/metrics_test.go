package api

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetrics(t *testing.T) {
	env := newEnv(t)
	a := env.activeUser("alice")
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(40), "body": sealed(100)})
	cur := a.sync(t, 0).Cursor
	a.sync(t, cur)
	a.sync(t, cur)
	a.c.mustStatus(200, "POST", "/api/entries", map[string]any{"id": newUUID(), "header": sealed(40), "body": sealed(100)})
	a.sync(t, cur)

	rec := httptest.NewRecorder()
	env.srv.MetricsHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	out := rec.Body.String()
	for _, want := range []string{
		`journal_http_requests_total{route="GET /api/sync",code="2xx"} 4`,
		`journal_http_requests_total{route="POST /api/entries",code="2xx"} 2`,
		`journal_sync_pulls_total{result="full"} 1`,
		`journal_sync_pulls_total{result="empty"} 2`,
		`journal_sync_pulls_total{result="changes"} 1`,
		`journal_sync_items_total{kind="entry"} 2`,
		`journal_active_users{window="5m"} 1`,
	} {
		if !strings.Contains(out, want+"\n") {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// Ids never become labels.
	if strings.Contains(out, "/api/entries/") {
		t.Errorf("a path with an id leaked into the metrics:\n%s", out)
	}
}
