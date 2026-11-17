//go:build ios

package main

import (
	"github.com/k22i/Peli/internal/safego"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// imagePath is what the frontend asks for an http image on iOS
// (frontend/src/lib/artwork-url.ts, viaProxy): the webview can't load plain
// http from a domain (App Transport Security), Go's net/http isn't subject to
// it. ADR-0055 keeps ATS strict, so the images come through here rather than
// through an Info.plist exception.
const imagePath = "/__image"

const (
	imageLimit   = 8 << 20
	imageTimeout = 15 * time.Second
)

var imageClient = &http.Client{Timeout: imageTimeout}

// imageProxy answers GET /__image?url=<http url> with that image, and passes
// everything else on. Only http: URLs, only image/* answers, at most 8 MiB.
// The only caller is the app's own webview.
func imageProxy(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer safego.Recover("image proxy")
		if r.URL.Path != imagePath {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		target, err := url.Parse(r.URL.Query().Get("url"))
		if err != nil || target.Scheme != "http" || target.Host == "" {
			http.Error(w, "not an http url", http.StatusBadRequest)
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
		if err != nil {
			http.Error(w, "bad url", http.StatusBadRequest)
			return
		}
		req.Header.Set("Accept", "image/*")
		resp, err := imageClient.Do(req)
		if err != nil {
			http.Error(w, "unreachable", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		kind := resp.Header.Get("Content-Type")
		if resp.StatusCode != http.StatusOK || !strings.HasPrefix(kind, "image/") {
			http.Error(w, "not an image", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", kind)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		io.Copy(w, io.LimitReader(resp.Body, imageLimit))
	})
}
