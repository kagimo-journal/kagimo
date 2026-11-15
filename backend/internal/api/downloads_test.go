package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestDownloads(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Kagimo-0.1.0.AppImage", "old")
	write("Kagimo-0.2.0.AppImage", "linux build")
	write("Kagimo-0.2.0.dmg", "mac")
	write("builder-debug.yml", "not an installer")
	write("secret.txt", "nor this")
	if err := os.Mkdir(filepath.Join(dir, "linux-unpacked.AppImage"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "secret.txt"), filepath.Join(dir, "link.exe")); err != nil {
		t.Fatal(err)
	}

	env := newEnv(t, func(c *Config) { c.Downloads = dir })
	c := env.client()

	list, _ := c.mustStatus(200, "GET", "/api/config", nil).json(t)["downloads"].([]any)
	if len(list) != 2 {
		t.Fatalf("want the newest installer per platform, got %v", list)
	}
	linux, mac := list[0].(map[string]any), list[1].(map[string]any)
	if linux["platform"] != "linux" || linux["name"] != "Kagimo-0.2.0.AppImage" || linux["size"] != float64(len("linux build")) {
		t.Fatalf("unexpected linux download %v", linux)
	}
	if mac["platform"] != "mac" || mac["name"] != "Kagimo-0.2.0.dmg" {
		t.Fatalf("unexpected mac download %v", mac)
	}

	r := c.mustStatus(200, "GET", "/download/Kagimo-0.2.0.AppImage", nil)
	if string(r.body) != "linux build" {
		t.Fatalf("unexpected body %q", r.body)
	}
	if got := r.header.Get("Content-Disposition"); got != `attachment; filename="Kagimo-0.2.0.AppImage"` {
		t.Fatalf("unexpected Content-Disposition %q", got)
	}

	// Only what's listed is served: not older builds, other files, links, or paths.
	for _, name := range []string{"Kagimo-0.1.0.AppImage", "secret.txt", "builder-debug.yml", "link.exe", "..%2Fsecret.txt", "%2e%2e%2f%2e%2e%2fetc%2fpasswd", "nope.dmg"} {
		c.mustStatus(404, "GET", "/download/"+name, nil)
	}
}

func TestNoDownloadsFolder(t *testing.T) {
	env := newEnv(t)
	c := env.client()
	if d, ok := c.mustStatus(200, "GET", "/api/config", nil).json(t)["downloads"]; ok {
		t.Fatalf("no downloads expected, got %v", d)
	}
	c.mustStatus(404, "GET", "/download/Kagimo-0.2.0.AppImage", nil)
}

// fakeGitHub answers /repos/{repo}/releases/latest with status and body, counting requests.
func fakeGitHub(t *testing.T, status *int, body *string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/repos/kagimo-journal/kagimo-releases/releases/latest" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(*status)
		_, _ = w.Write([]byte(*body))
	}))
	t.Cleanup(gh.Close)
	return gh, &calls
}

func TestDownloadsFromGitHubRelease(t *testing.T) {
	const dl = "https://github.com/kagimo-journal/kagimo-releases/releases/download/v0.2.0/"
	status, body := http.StatusOK, `{"tag_name":"v0.2.0","assets":[
		{"name":"Kagimo-0.2.0-universal.dmg","size":230000000,"browser_download_url":"`+dl+`Kagimo-0.2.0-universal.dmg"},
		{"name":"Kagimo-0.2.0-universal.dmg.blockmap","size":200,"browser_download_url":"`+dl+`Kagimo-0.2.0-universal.dmg.blockmap"},
		{"name":"Kagimo-0.2.0.exe","size":90000000,"browser_download_url":"https://evil.example/Kagimo-0.2.0.exe"},
		{"name":"Kagimo-0.2.0.AppImage","size":120000000,"browser_download_url":"https://github.com/someone-else/repo/releases/download/v1/Kagimo-0.2.0.AppImage"}
	]}`
	gh, calls := fakeGitHub(t, &status, &body)
	folder := t.TempDir() // ignored when a repo is set
	if err := os.WriteFile(filepath.Join(folder, "Kagimo-9.9.9.AppImage"), []byte("local"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := newEnv(t, func(c *Config) {
		c.Downloads = folder
		c.DownloadsRepo = "kagimo-journal/kagimo-releases"
		c.GitHubAPI = gh.URL
	})
	c := env.client()

	list, _ := c.mustStatus(200, "GET", "/api/config", nil).json(t)["downloads"].([]any)
	if len(list) != 1 {
		t.Fatalf("want only the mac installer (other links point elsewhere), got %v", list)
	}
	mac := list[0].(map[string]any)
	if mac["platform"] != "mac" || mac["name"] != "Kagimo-0.2.0-universal.dmg" || mac["size"] != float64(230000000) || mac["url"] != dl+"Kagimo-0.2.0-universal.dmg" {
		t.Fatalf("unexpected mac download %v", mac)
	}

	// The old path redirects to GitHub; nothing else is served.
	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := noFollow.Get(env.ts.URL + "/download/Kagimo-0.2.0-universal.dmg")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != dl+"Kagimo-0.2.0-universal.dmg" {
		t.Fatalf("want a redirect to GitHub, got %d %q", res.StatusCode, res.Header.Get("Location"))
	}
	c.mustStatus(404, "GET", "/download/Kagimo-9.9.9.AppImage", nil)
	c.mustStatus(404, "GET", "/download/Kagimo-0.2.0.exe", nil)

	// Cached: the second request doesn't ask GitHub again, and a GitHub failure later keeps the list.
	c.mustStatus(200, "GET", "/api/config", nil)
	if n := calls.Load(); n != 1 {
		t.Fatalf("want 1 request to GitHub, got %d", n)
	}
	status = http.StatusInternalServerError
	env.clock.Advance(releaseTTL)
	c.mustStatus(200, "GET", "/api/config", nil) // starts the refresh
	waitFor(t, func() bool { return calls.Load() == 2 })
	if list, _ := c.mustStatus(200, "GET", "/api/config", nil).json(t)["downloads"].([]any); len(list) != 1 {
		t.Fatalf("a failed refresh should keep the last list, got %v", list)
	}
}

func TestDownloadsNoReleaseYet(t *testing.T) {
	status, body := http.StatusNotFound, `{"message":"Not Found"}`
	gh, _ := fakeGitHub(t, &status, &body)
	env := newEnv(t, func(c *Config) {
		c.DownloadsRepo = "kagimo-journal/kagimo-releases"
		c.GitHubAPI = gh.URL
	})
	if d, ok := env.client().mustStatus(200, "GET", "/api/config", nil).json(t)["downloads"]; ok {
		t.Fatalf("no downloads expected, got %v", d)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}
