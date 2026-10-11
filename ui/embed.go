package ui

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"time"
)

//go:embed all:dist
var DistFS embed.FS

// Handler returns an http.Handler that serves the embedded Vite SPA
func Handler() http.Handler {
	distSub, err := fs.Sub(DistFS, "dist")
	if err != nil {
		panic(err)
	}

	fileServer := http.FileServer(http.FS(distSub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleanPath := strings.TrimPrefix(r.URL.Path, "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		// Try opening the requested file in embedded FS
		f, err := distSub.Open(cleanPath)
		if err == nil {
			stat, sErr := f.Stat()
			if sErr == nil && !stat.IsDir() {
				_ = f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
			_ = f.Close()
		}

		// Fallback to index.html for SPA client-side routing
		indexFile, err := distSub.Open("index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer indexFile.Close()

		stat, _ := indexFile.Stat()
		var modTime time.Time
		if stat != nil {
			modTime = stat.ModTime()
		}

		if seeker, ok := indexFile.(io.ReadSeeker); ok {
			http.ServeContent(w, r, "index.html", modTime, seeker)
			return
		}

		content, err := io.ReadAll(indexFile)
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(content)
	})
}
