package livetv

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// What each part of a source costs to fetch. A playlist is a list of names
// and links; a guide carries every channel's week, and a gzipped one is far
// smaller on the wire than in memory.
const (
	playlistLimit      = 50 << 20
	guideLimit         = 200 << 20
	guideUnzippedLimit = 1 << 30
)

// A playlist is a few hundred KB at most; a guide from a big provider takes
// longer to arrive but should still never hold the app.
const (
	playlistTimeout = 60 * time.Second
	guideTimeout    = 5 * time.Minute
)

// checkURL trims raw and says whether it can be fetched: an http(s) URL with a
// host, a file:// URL, an absolute path or a ~/ path. It returns the trimmed
// original, which is what the keychain keeps.
func checkURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fail(CodeInvalid)
	}
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "http://"), strings.HasPrefix(lower, "https://"):
		u, err := url.Parse(trimmed)
		if err != nil || u.Host == "" {
			return "", fail(CodeInvalid)
		}
		return trimmed, nil
	case strings.HasPrefix(lower, "file://"):
		u, err := url.Parse(trimmed)
		if err != nil || u.Path == "" {
			return "", fail(CodeInvalid)
		}
		return trimmed, nil
	case strings.HasPrefix(trimmed, "~/"):
		if home, err := os.UserHomeDir(); err != nil || home == "" {
			return "", fail(CodeInvalid)
		}
		return trimmed, nil
	case filepath.IsAbs(trimmed):
		return trimmed, nil
	}
	return "", fail(CodeInvalid)
}

// localPath is where a checked URL's file lives: ok is false for an http(s)
// URL, which is fetched over the network instead.
func localPath(checked string) (path string, ok bool) {
	lower := strings.ToLower(checked)
	if strings.HasPrefix(lower, "file://") {
		u, err := url.Parse(checked)
		if err != nil || u.Path == "" {
			return "", false
		}
		return u.Path, true
	}
	if strings.HasPrefix(checked, "~/") {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", false
		}
		return filepath.Join(home, checked[2:]), true
	}
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return "", false
	}
	return checked, true
}

// open returns the body of a checked URL, reading at most limit bytes of it.
func (s *Service) open(ctx context.Context, raw string, limit int64) (io.ReadCloser, error) {
	checked, err := checkURL(raw)
	if err != nil {
		return nil, err
	}
	if path, isFile := localPath(checked); isFile {
		f, err := os.Open(path)
		if err != nil {
			return nil, fail(CodeUnreachable)
		}
		return &limitBody{reader: &limitReader{r: f, left: limit}, closer: f}, nil
	}
	// The URL holds whatever credentials the provider put in it, and
	// http.NewRequest keeps it in the error it returns: only codes go on.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, checked, nil)
	if err != nil {
		return nil, fail(CodeUnreachable)
	}
	req.Header.Set("User-Agent", userAgent(s.cfg.Version))
	resp, err := s.httpc.Do(req)
	if err != nil {
		return nil, fail(fetchCode(err))
	}
	if resp.StatusCode >= http.StatusBadRequest {
		resp.Body.Close()
		return nil, fail(CodeUnreachable)
	}
	if resp.ContentLength > limit {
		resp.Body.Close()
		return nil, fail(CodeTooLarge)
	}
	return &limitBody{reader: &limitReader{r: resp.Body, left: limit}, closer: resp.Body}, nil
}

// userAgent is what Peli calls itself to a playlist's host.
func userAgent(version string) string {
	if version == "" {
		return "Peli"
	}
	return "Peli/" + version
}

// limitReader fails with CodeTooLarge once more than its allowance of bytes
// has been read, so a provider answering with more than it promised stops
// short of filling memory. A body with no Content-Length is caught here.
type limitReader struct {
	r    io.Reader
	left int64
}

func (l *limitReader) Read(p []byte) (int, error) {
	if l.left < 0 {
		return 0, fail(CodeTooLarge)
	}
	// Ask for one byte past the allowance: reading it is how we find out.
	if room := l.left + 1; int64(len(p)) > room {
		p = p[:room]
	}
	n, err := l.r.Read(p)
	l.left -= int64(n)
	if l.left < 0 {
		return n, fail(CodeTooLarge)
	}
	return n, err
}

// limitBody is a limitReader that can be closed.
type limitBody struct {
	reader *limitReader
	closer io.Closer
}

func (b *limitBody) Read(p []byte) (int, error) { return b.reader.Read(p) }

func (b *limitBody) Close() error { return b.closer.Close() }

// fetchCode names a fetch's failure for the frontend. An error's text can hold
// the URL it was made for, which is a secret: only the code leaves here.
func fetchCode(err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return CodeTimeout
	case errors.Is(err, ErrNotPlaylist):
		return CodeNotPlaylist
	case errors.Is(err, ErrNotGuide):
		return CodeNotGuide
	case errors.Is(err, os.ErrNotExist):
		return CodeUnreachable
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		if netErr.Timeout() {
			return CodeTimeout
		}
		return CodeUnreachable
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return CodeUnreachable
	}
	return codeOf(err)
}
