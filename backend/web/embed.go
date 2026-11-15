// Package web embeds and serves the built single-page app (Vite output in dist/).
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// dist holds the Vite build. In a fresh checkout it contains only .gitkeep (the
// frontend build re-creates that file), so the binary still compiles; the server
// then shows placeholder.html until the web app is built.
//
//go:embed all:dist
var dist embed.FS

//go:embed placeholder.html
var placeholder []byte

// Handler serves the SPA: existing files are served directly; any other path
// that is not under /api/ falls back to index.html so client-side routes work.
// Vite's content-hashed files under /assets/ get a long immutable cache.
func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return NewHandler(sub)
}

// NewHandler serves an SPA from fsys (exposed for tests).
func NewHandler(fsys fs.FS) http.Handler {
	files := http.FileServerFS(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" || name == "index.html" {
			serveIndex(w, r, fsys)
			return
		}
		st, err := fs.Stat(fsys, name)
		if err != nil || st.IsDir() {
			// A missing hashed asset (an old tab asking for a chunk a deploy replaced) is a real
			// 404: index.html in its place fails as a script in confusing ways and could be cached.
			if strings.HasPrefix(name, "assets/") {
				w.Header().Set("Cache-Control", "no-store")
				http.NotFound(w, r)
				return
			}
			serveIndex(w, r, fsys)
			return
		}
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	b, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		b = placeholder
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(b)
	}
}
