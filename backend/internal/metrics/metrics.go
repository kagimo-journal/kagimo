// Package metrics is a minimal Prometheus text-format registry: counters, histograms and
// gauges computed at scrape time, with labels. No dependencies; just enough to answer "how often
// is the app hit, by what, and by how many people" on a dashboard.
//
// Nothing personal goes in a label: routes are mux patterns ("PUT /api/entries/{id}"), never
// paths or ids.
package metrics

import (
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"sync"
)

type family struct {
	name, help, kind string
	labels           []string
	buckets          []float64 // histograms only

	mu     sync.Mutex
	series map[string]*series // key: label values joined by \xff
}

type series struct {
	values []string
	value  float64  // counter
	counts []uint64 // histogram: per bucket (not cumulative), last is +Inf
	sum    float64  // histogram
}

// Registry holds metric families in registration order.
type Registry struct {
	mu       sync.Mutex
	families []*family
	gauges   []gaugeFunc
}

type gaugeFunc struct {
	name, help, label string
	fn                func() map[string]float64
}

func New() *Registry { return &Registry{} }

func (r *Registry) add(f *family) *family {
	f.series = map[string]*series{}
	r.mu.Lock()
	r.families = append(r.families, f)
	r.mu.Unlock()
	return f
}

func (f *family) get(values []string) *series {
	if len(values) != len(f.labels) {
		panic(fmt.Sprintf("metrics: %s wants %d labels, got %d", f.name, len(f.labels), len(values)))
	}
	key := strings.Join(values, "\xff")
	s := f.series[key]
	if s == nil {
		s = &series{values: append([]string(nil), values...)}
		if f.buckets != nil {
			s.counts = make([]uint64, len(f.buckets)+1)
		}
		f.series[key] = s
	}
	return s
}

// Counter only goes up.
type Counter struct{ f *family }

func (r *Registry) Counter(name, help string, labels ...string) *Counter {
	return &Counter{r.add(&family{name: name, help: help, kind: "counter", labels: labels})}
}

func (c *Counter) Add(v float64, labels ...string) {
	c.f.mu.Lock()
	c.f.get(labels).value += v
	c.f.mu.Unlock()
}

func (c *Counter) Inc(labels ...string) { c.Add(1, labels...) }

// Histogram counts observations into buckets (upper bounds, ascending).
type Histogram struct{ f *family }

func (r *Registry) Histogram(name, help string, buckets []float64, labels ...string) *Histogram {
	return &Histogram{r.add(&family{name: name, help: help, kind: "histogram", labels: labels, buckets: buckets})}
}

func (h *Histogram) Observe(v float64, labels ...string) {
	i := sort.SearchFloat64s(h.f.buckets, v) // first bucket with bound >= v
	h.f.mu.Lock()
	s := h.f.get(labels)
	s.counts[i]++
	s.sum += v
	h.f.mu.Unlock()
}

// GaugeFunc reports values computed at scrape time, one series per key of fn's result, under
// the given label.
func (r *Registry) GaugeFunc(name, help, label string, fn func() map[string]float64) {
	r.mu.Lock()
	r.gauges = append(r.gauges, gaugeFunc{name, help, label, fn})
	r.mu.Unlock()
}

// WriteText writes every metric in the Prometheus text exposition format.
func (r *Registry) WriteText(w io.Writer) error {
	r.mu.Lock()
	fams := append([]*family(nil), r.families...)
	gauges := append([]gaugeFunc(nil), r.gauges...)
	r.mu.Unlock()

	var b strings.Builder
	for _, f := range fams {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", f.name, f.help, f.name, f.kind)
		f.mu.Lock()
		keys := make([]string, 0, len(f.series))
		for k := range f.series {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			s := f.series[k]
			if f.kind == "counter" {
				fmt.Fprintf(&b, "%s%s %s\n", f.name, labelStr(f.labels, s.values, "", ""), num(s.value))
				continue
			}
			var cum uint64
			for i, c := range s.counts {
				cum += c
				le := "+Inf"
				if i < len(f.buckets) {
					le = num(f.buckets[i])
				}
				fmt.Fprintf(&b, "%s_bucket%s %d\n", f.name, labelStr(f.labels, s.values, "le", le), cum)
			}
			fmt.Fprintf(&b, "%s_sum%s %s\n", f.name, labelStr(f.labels, s.values, "", ""), num(s.sum))
			fmt.Fprintf(&b, "%s_count%s %d\n", f.name, labelStr(f.labels, s.values, "", ""), cum)
		}
		f.mu.Unlock()
	}
	for _, g := range gauges {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n", g.name, g.help, g.name)
		vals := g.fn()
		keys := make([]string, 0, len(vals))
		for k := range vals {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&b, "%s{%s=%q} %s\n", g.name, g.label, k, num(vals[k]))
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}

func labelStr(names, values []string, extraName, extraValue string) string {
	if len(names) == 0 && extraName == "" {
		return ""
	}
	parts := make([]string, 0, len(names)+1)
	for i, n := range names {
		parts = append(parts, fmt.Sprintf("%s=%q", n, values[i]))
	}
	if extraName != "" {
		parts = append(parts, fmt.Sprintf("%s=%q", extraName, extraValue))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func num(v float64) string {
	if math.IsInf(v, 1) {
		return "+Inf"
	}
	return fmt.Sprintf("%g", v)
}
