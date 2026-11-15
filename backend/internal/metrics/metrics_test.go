package metrics

import (
	"strings"
	"testing"
)

func TestWriteText(t *testing.T) {
	r := New()
	c := r.Counter("req_total", "Requests.", "route", "code")
	c.Inc("GET /a", "2xx")
	c.Inc("GET /a", "2xx")
	c.Add(3, "GET /b", "4xx")
	h := r.Histogram("dur_seconds", "Duration.", []float64{0.1, 1}, "route")
	h.Observe(0.05, "GET /a")
	h.Observe(0.5, "GET /a")
	h.Observe(5, "GET /a")
	r.GaugeFunc("users", "Users.", "window", func() map[string]float64 { return map[string]float64{"5m": 2} })

	var b strings.Builder
	if err := r.WriteText(&b); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	for _, want := range []string{
		"# TYPE req_total counter\n",
		`req_total{route="GET /a",code="2xx"} 2` + "\n",
		`req_total{route="GET /b",code="4xx"} 3` + "\n",
		`dur_seconds_bucket{route="GET /a",le="0.1"} 1` + "\n",
		`dur_seconds_bucket{route="GET /a",le="1"} 2` + "\n",
		`dur_seconds_bucket{route="GET /a",le="+Inf"} 3` + "\n",
		`dur_seconds_sum{route="GET /a"} 5.55` + "\n",
		`dur_seconds_count{route="GET /a"} 3` + "\n",
		"# TYPE users gauge\n",
		`users{window="5m"} 2` + "\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}
