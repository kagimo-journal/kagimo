package api

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"

	"journal/internal/metrics"
)

// apiMetrics are the server's Prometheus metrics, served on a separate listener (see
// MetricsHandler) so they never share the public port. Labels carry route patterns and status
// classes only: no paths, ids or anything else personal.
type apiMetrics struct {
	reg       *metrics.Registry
	requests  *metrics.Counter
	duration  *metrics.Histogram
	bytesOut  *metrics.Counter
	syncPulls *metrics.Counter
	syncItems *metrics.Counter
	active    *activeUsers
}

func newAPIMetrics(now func() time.Time) *apiMetrics {
	reg := metrics.New()
	m := &apiMetrics{
		reg: reg,
		requests: reg.Counter("journal_http_requests_total",
			"HTTP requests by route pattern and status class.", "route", "code"),
		duration: reg.Histogram("journal_http_request_duration_seconds",
			"Time to answer, by route pattern.", []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5}, "route"),
		bytesOut: reg.Counter("journal_http_response_bytes_total",
			"Response body bytes, by route pattern.", "route"),
		syncPulls: reg.Counter("journal_sync_pulls_total",
			"Change-feed pages served: empty (nothing new), changes, or full (since=0).", "result"),
		syncItems: reg.Counter("journal_sync_items_total",
			"Items sent in change-feed pages, by kind.", "kind"),
		active: &activeUsers{last: map[string]time.Time{}},
	}
	windows := []struct {
		name string
		d    time.Duration
	}{{"5m", 5 * time.Minute}, {"1h", time.Hour}, {"24h", 24 * time.Hour}}
	reg.GaugeFunc("journal_active_users",
		"Distinct signed-in users who made a request within the window (since this machine started).", "window",
		func() map[string]float64 {
			out := map[string]float64{}
			for _, w := range windows {
				out[w.name] = 0
			}
			m.active.each(now(), windows[len(windows)-1].d, func(age time.Duration) {
				for _, w := range windows {
					if age <= w.d {
						out[w.name]++
					}
				}
			})
			return out
		})
	return m
}

// MetricsHandler serves the metrics in the Prometheus text format.
func (s *Server) MetricsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_ = s.metrics.reg.WriteText(w)
	})
}

// activeUsers remembers when each user last made a request, in memory only.
type activeUsers struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func (a *activeUsers) seen(id string, now time.Time) {
	a.mu.Lock()
	a.last[id] = now
	a.mu.Unlock()
}

// each calls fn with the age of every user seen within keep, and forgets older ones.
func (a *activeUsers) each(now time.Time, keep time.Duration, fn func(age time.Duration)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, t := range a.last {
		age := now.Sub(t)
		if age > keep {
			delete(a.last, id)
			continue
		}
		fn(age)
	}
}

// reqInfo is filled in as a request passes through: the mux pattern it matched and the
// signed-in user, read back by logRequests once the response is written.
type reqInfo struct {
	route  string
	userID string
}

type reqInfoKey struct{}

func info(r *http.Request) *reqInfo {
	ri, _ := r.Context().Value(reqInfoKey{}).(*reqInfo)
	return ri
}

func withReqInfo(r *http.Request) (*http.Request, *reqInfo) {
	ri := &reqInfo{}
	return r.WithContext(context.WithValue(r.Context(), reqInfoKey{}, ri)), ri
}

// tagRoute records which pattern a request matched.
func tagRoute(pattern string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ri := info(r); ri != nil {
			ri.route = pattern
		}
		next.ServeHTTP(w, r)
	})
}

func (m *apiMetrics) observe(r *http.Request, ri *reqInfo, status int, bytes int64, dur time.Duration, now time.Time) {
	route := ri.route
	if route == "" {
		if isAPI(r.URL.Path) {
			route = "unmatched"
		} else {
			route = "static"
		}
	}
	m.requests.Inc(route, strconv.Itoa(status/100)+"xx")
	m.duration.Observe(dur.Seconds(), route)
	m.bytesOut.Add(float64(bytes), route)
	if ri.userID != "" {
		m.active.seen(ri.userID, now)
	}
}

func (m *apiMetrics) syncPage(since int64, entries, blobs, deleted int, settings bool) {
	switch {
	case since == 0:
		m.syncPulls.Inc("full")
	case entries+blobs+deleted == 0 && !settings:
		m.syncPulls.Inc("empty")
	default:
		m.syncPulls.Inc("changes")
	}
	m.syncItems.Add(float64(entries), "entry")
	m.syncItems.Add(float64(blobs), "blob")
	m.syncItems.Add(float64(deleted), "deletion")
	if settings {
		m.syncItems.Inc("settings")
	}
}
