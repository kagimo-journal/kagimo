package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Installers offered from a GitHub repository's latest release (Config.DownloadsRepo)
// instead of a local folder. The front page links straight to GitHub, so the 200 MB
// files never pass through this server.
//
// GitHub allows 60 unauthenticated API requests an hour per IP. The answer is kept for
// releaseTTL (releaseRetry after a failure), so a busy front page costs about six.
const (
	releaseTTL      = 10 * time.Minute
	releaseRetry    = time.Minute
	releaseFirstMax = 2 * time.Second // how long /api/config waits for the first answer after a start
)

type releaseCache struct {
	mu         sync.Mutex
	list       []download
	next       time.Time     // when to ask GitHub again; zero = never asked
	refreshing bool          // a request to GitHub is in flight
	first      chan struct{} // closed when the first request to GitHub has finished
}

// releaseDownloads returns the installers of the latest release, starting a refresh in
// the background when the list is due one. Only the first call after the server starts
// waits for GitHub, and then for at most releaseFirstMax: /api/config is also the health
// check.
func (s *Server) releaseDownloads() []download {
	c := &s.releases
	c.mu.Lock()
	if !c.refreshing && !s.cfg.Now().Before(c.next) {
		c.refreshing = true
		if c.first == nil {
			c.first = make(chan struct{})
		}
		go s.refreshReleases()
	}
	first := c.first
	c.mu.Unlock()

	select {
	case <-first:
	case <-time.After(releaseFirstMax):
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.list
}

func (s *Server) refreshReleases() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	list, err := s.fetchRelease(ctx)

	c := &s.releases
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		// Keep offering what the last good answer listed.
		s.log.Warn("downloads: latest release", "repo", s.cfg.DownloadsRepo, "err", err)
		c.next = s.cfg.Now().Add(releaseRetry)
	} else {
		c.list = list
		c.next = s.cfg.Now().Add(releaseTTL)
	}
	c.refreshing = false
	select {
	case <-c.first:
	default:
		close(c.first)
	}
}

func (s *Server) fetchRelease(ctx context.Context) ([]download, error) {
	api := s.cfg.GitHubAPI
	if api == "" {
		api = "https://api.github.com"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api+"/repos/"+s.cfg.DownloadsRepo+"/releases/latest", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "kagimo-server")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, nil // no release published yet: nothing to offer
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered %s", res.Status)
	}
	var rel struct {
		Assets []struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&rel); err != nil {
		return nil, err
	}

	// Links go into the front page, so only ones to this repository's release files.
	prefix := "https://github.com/" + s.cfg.DownloadsRepo + "/releases/download/"
	var out []download
	for _, a := range rel.Assets {
		platform, ok := downloadPlatforms[strings.ToLower(extOf(a.Name))]
		if !ok || !strings.HasPrefix(a.URL, prefix) {
			continue
		}
		out = append(out, download{Platform: platform, Name: a.Name, Size: a.Size, URL: a.URL})
	}
	return newestPerPlatform(out), nil
}

// extOf is filepath.Ext for a name that isn't a path.
func extOf(name string) string {
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		return name[i:]
	}
	return ""
}

// newestPerPlatform keeps one installer per platform, the one with the greatest name
// (versions sort upwards), ordered by platform.
func newestPerPlatform(all []download) []download {
	sort.Slice(all, func(i, j int) bool { return all[i].Name > all[j].Name })
	seen := map[string]bool{}
	kept := all[:0]
	for _, d := range all {
		if !seen[d.Platform] {
			seen[d.Platform] = true
			kept = append(kept, d)
		}
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].Platform < kept[j].Platform })
	return kept
}
