package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A download is one installer of the desktop app (desktop/) that this server offers.
type download struct {
	Platform string `json:"platform"` // linux, mac or windows
	Name     string `json:"name"`     // the file's name, as in /download/{name}
	Size     int64  `json:"size"`
	URL      string `json:"url,omitempty"` // set for a release on GitHub (Config.DownloadsRepo); otherwise /download/{name}
}

// downloadPlatforms maps what electron-builder makes (desktop/package.json "build") to
// the system it is for. Nothing else in the folder is offered.
var downloadPlatforms = map[string]string{
	".appimage": "linux",
	".dmg":      "mac",
	".exe":      "windows",
}

// downloads lists the installers on offer: the latest GitHub release's when
// Config.DownloadsRepo is set (downloads_github.go), otherwise the ones in the downloads
// folder (Config.Downloads), read each time so a new build shows up without a restart.
// Empty when neither is set.
func (s *Server) downloads() []download {
	if s.cfg.DownloadsRepo != "" {
		return s.releaseDownloads()
	}
	if s.cfg.Downloads == "" {
		return nil
	}
	entries, err := os.ReadDir(s.cfg.Downloads)
	if err != nil {
		return nil
	}
	var out []download
	for _, e := range entries {
		platform, ok := downloadPlatforms[strings.ToLower(filepath.Ext(e.Name()))]
		if !ok || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		// Regular files only: a link could point anywhere.
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		out = append(out, download{Platform: platform, Name: e.Name(), Size: info.Size()})
	}
	return newestPerPlatform(out)
}

// handleDownload serves one of the installers listed by downloads, or redirects to it on
// GitHub. The name is matched against that list, never joined to a path as given.
func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	for _, d := range s.downloads() {
		if d.Name != name {
			continue
		}
		if d.URL != "" {
			http.Redirect(w, r, d.URL, http.StatusFound)
			return nil
		}
		f, err := os.Open(filepath.Join(s.cfg.Downloads, d.Name))
		if err != nil {
			return errNotFound
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return errNotFound
		}
		// An installer is around 100 MB: on a slow line it outlasts the server's write timeout.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="`+strings.NewReplacer(`"`, "", `\`, "").Replace(d.Name)+`"`)
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "", info.ModTime(), f)
		return nil
	}
	return errNotFound
}
