package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSPAHandler(t *testing.T) {
	h := NewHandler(fstest.MapFS{
		"index.html":           {Data: []byte("<html>app</html>")},
		"assets/app-abc123.js": {Data: []byte("console.log(1)")},
		"favicon.svg":          {Data: []byte("<svg/>")},
	})
	cases := []struct {
		path, wantBody, wantCache string
		wantStatus                int
	}{
		{"/", "<html>app</html>", "no-cache", 200},
		{"/e/1234", "<html>app</html>", "no-cache", 200},
		{"/settings/appearance", "<html>app</html>", "no-cache", 200},
		{"/assets/app-abc123.js", "console.log(1)", "public, max-age=31536000, immutable", 200},
		{"/favicon.svg", "<svg/>", "no-cache", 200},
		{"/api/unknown", "", "", 404},
		{"/assets/app-old999.js", "", "no-store", 404},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("GET", tc.path, nil))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status %d", rec.Code)
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Fatalf("body %q", rec.Body.String())
			}
			if tc.wantCache != "" && rec.Header().Get("Cache-Control") != tc.wantCache {
				t.Fatalf("cache %q", rec.Header().Get("Cache-Control"))
			}
		})
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status %d", rec.Code)
	}
}

func TestEmbeddedIndex(t *testing.T) {
	// Works both with a built frontend and with only dist/.gitkeep (placeholder page).
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<html") {
		t.Fatalf("index not served: %d %q", rec.Code, rec.Body.String())
	}
}

func TestPlaceholderWhenNotBuilt(t *testing.T) {
	h := NewHandler(fstest.MapFS{".gitkeep": {Data: nil}})
	for _, p := range []string{"/", "/signin", "/index.html"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "make build") {
			t.Fatalf("%s: status %d body %q", p, rec.Code, rec.Body.String())
		}
	}
}
