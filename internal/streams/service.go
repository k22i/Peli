// Package streams resolves a picked stream into what the player loads
// (#53): an addon's direct HTTP or debrid link, asked once with the headers
// the addon names, through its redirects, to the file itself. It tells the
// file apart from what debrid addons send instead of one: a short notice
// video ("still downloading", "can't open this"), an expired link or a web
// page. See ADR-0037.
//
// Stream URLs carry the user's debrid key (Torrentio puts it in the path),
// and the links they redirect to carry tokens, so no URL is logged or put in
// an error.
package streams

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

var (
	// ErrInvalidURL means the URL isn't an absolute http or https URL.
	ErrInvalidURL = errors.New("streams: not an http or https URL")
	// ErrUnreachable means the link couldn't be reached: no network, DNS,
	// TLS or a dropped connection.
	ErrUnreachable = errors.New("streams: link unreachable")
	// ErrTimeout means the link didn't answer within MaxWait.
	ErrTimeout = errors.New("streams: link didn't answer")
	// ErrRedirects means the link redirected more than MaxRedirects times.
	ErrRedirects = errors.New("streams: too many redirects")
	// ErrExpired means the link no longer works: 401, 403, 404 or 410. Links
	// to a debrid service's files expire; the addon gives a new one.
	ErrExpired = errors.New("streams: link expired")
	// ErrBusy means the service is rate limiting: 429, or its notice says
	// the account's limits are reached.
	ErrBusy = errors.New("streams: limit reached")
	// ErrUnavailable means the service failed: a 5xx answer.
	ErrUnavailable = errors.New("streams: service unavailable")
	// ErrNotVideo means the link answered with a web page or JSON.
	ErrNotVideo = errors.New("streams: not a video")
	// ErrCaching means a debrid service doesn't have the file yet and is
	// fetching it: the addon sent its "downloading" notice.
	ErrCaching = errors.New("streams: debrid service is still downloading")
	// ErrDenied means the debrid service refused the account: a bad key, an
	// expired plan or a blocked IP, by its notice.
	ErrDenied = errors.New("streams: debrid service refused access")
	// ErrFailed means the debrid service couldn't serve the file (a failed
	// download, an archive, a takedown) or the addon sent some other notice.
	ErrFailed = errors.New("streams: debrid service couldn't serve it")
)

// Error codes the frontend reads (MarshalError).
const (
	CodeInvalidURL  = "invalid_url"
	CodeUnreachable = "unreachable"
	CodeTimeout     = "timeout"
	CodeRedirects   = "redirects"
	CodeExpired     = "expired"
	CodeBusy        = "busy"
	CodeUnavailable = "unavailable"
	CodeNotVideo    = "not_video"
	CodeCaching     = "caching"
	CodeDenied      = "denied"
	CodeFailed      = "failed"
)

const (
	// MaxWait caps one resolve. Torrentio took 4.8 s to answer for a file
	// TorBox didn't have (adding it there first) and 1.3 s for one it had.
	MaxWait = 30 * time.Second
	// MaxRedirects caps the hops. Torrentio with TorBox takes two: its
	// resolve URL, then TorBox's requestdl, then the CDN.
	MaxRedirects = 10
	// NoticeMax is the largest video taken for a notice. Torrentio's are
	// about 120 KB; no film or episode is this small.
	NoticeMax = 16 << 20
)

// Request is a stream to resolve: its url and the headers its addon asks
// for (behaviorHints.proxyHeaders.request).
type Request struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

// Source is what the player (#60) loads: where the link's redirects led,
// with the headers and user agent to ask for it with. Loading URL rather
// than Origin skips the redirects a second time (1.7 s with Torrentio and
// TorBox); if URL expires during playback, resolve Origin again.
type Source struct {
	URL       string            `json:"url"`
	Origin    string            `json:"origin"`
	Headers   map[string]string `json:"headers"`
	UserAgent string            `json:"userAgent"`
	// The file's media type and size in bytes, when the server says.
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

// HeaderFields is Headers as mpv's http-header-fields takes them, sorted.
// Set it as a list: a value can hold a comma, which mpv's string form
// splits on.
func (s Source) HeaderFields() []string {
	fields := make([]string, 0, len(s.Headers))
	for name, value := range s.Headers {
		fields = append(fields, name+": "+value)
	}
	slices.Sort(fields)
	return fields
}

// Service is the Wails service the frontend calls to resolve a stream.
type Service struct {
	http      *http.Client
	userAgent string
	maxWait   time.Duration
}

// NewService returns a Service that sends version in its User-Agent, unless
// the addon names one.
func NewService(version string) *Service {
	return &Service{
		http: &http.Client{
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) > MaxRedirects {
					return ErrRedirects
				}
				// Go sends the previous URL as the Referer, which would hand
				// the next host the debrid key in Torrentio's path.
				if via[0].Header.Get("Referer") == "" {
					req.Header.Del("Referer")
				}
				return nil
			},
		},
		userAgent: fmt.Sprintf("Sinag/%s (+https://github.com/k22i/Sinag)", version),
		maxWait:   MaxWait,
	}
}

// Resolve asks for the first byte of req's link, following its redirects,
// and returns the Source to play, or an error saying why the link won't
// play. Cancelling the call in the frontend cancels the request.
func (s *Service) Resolve(ctx context.Context, req Request) (Source, error) {
	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return Source{}, ErrInvalidURL
	}
	headers, userAgent := s.headers(req.Headers)

	ctx, cancel := context.WithTimeoutCause(ctx, s.maxWait, ErrTimeout)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Source{}, ErrInvalidURL
	}
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	r.Header.Set("User-Agent", userAgent)
	// The first byte is enough to learn the file's type and size.
	r.Header.Set("Range", "bytes=0-0")

	resp, err := s.http.Do(r)
	if err != nil {
		return Source{}, failure(ctx, err)
	}
	// Not read: closing drops the rest, if the server ignored Range.
	defer resp.Body.Close()

	final := resp.Request.URL
	if err := check(resp, final); err != nil {
		return Source{}, err
	}
	return Source{
		URL:         final.String(),
		Origin:      u.String(),
		Headers:     headers,
		UserAgent:   userAgent,
		ContentType: mediaType(resp.Header.Get("Content-Type")),
		Size:        size(resp),
	}, nil
}

// Headers the player can't take from an addon: it sets them itself.
var reserved = map[string]bool{
	"Range": true, "Host": true, "Content-Length": true, "Connection": true,
	"Transfer-Encoding": true, "Accept-Encoding": true,
}

var token = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

// headers splits an addon's headers into the ones to send and the user
// agent, dropping any the player sets itself or that aren't valid.
func (s *Service) headers(in map[string]string) (map[string]string, string) {
	out := map[string]string{}
	userAgent := s.userAgent
	for name, value := range in {
		if !token.MatchString(name) || strings.ContainsAny(value, "\r\n\x00") {
			continue
		}
		name = http.CanonicalHeaderKey(name)
		switch {
		case name == "User-Agent":
			if value != "" {
				userAgent = value
			}
		case !reserved[name]:
			out[name] = value
		}
	}
	return out, userAgent
}

// check says why an answer isn't a file to play, if it isn't one.
func check(resp *http.Response, final *url.URL) error {
	switch status := resp.StatusCode; {
	case status == http.StatusUnauthorized, status == http.StatusForbidden,
		status == http.StatusNotFound, status == http.StatusGone:
		return ErrExpired
	case status == http.StatusTooManyRequests:
		return ErrBusy
	case status >= 500:
		return ErrUnavailable
	case status < 200 || status >= 300:
		return ErrUnreachable
	}
	kind := mediaType(resp.Header.Get("Content-Type"))
	if playlist(kind, final) {
		return nil
	}
	if kind == "text/html" || kind == "application/json" || kind == "application/xml" ||
		strings.HasPrefix(kind, "text/") {
		return ErrNotVideo
	}
	if n := size(resp); n > 0 && n <= NoticeMax {
		return notice(final)
	}
	return nil
}

// playlist reports an HLS or DASH manifest: text, and small, but playable.
func playlist(kind string, u *url.URL) bool {
	switch kind {
	case "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl",
		"audio/x-mpegurl", "application/dash+xml":
		return true
	}
	ext := strings.ToLower(path.Ext(u.Path))
	return ext == ".m3u8" || ext == ".mpd"
}

// What a notice video's name says, in the order to test: Torrentio's
// failed_access_v2.mp4 is about access, not a failure to download, and
// MediaFusion's torrent_not_downloaded.mp4 is a download still to happen.
var notices = []struct {
	words *regexp.Regexp
	err   error
}{
	{regexp.MustCompile(`limit`), ErrBusy},
	{regexp.MustCompile(`access|api_?key|auth|token|blocked|premium|subscription|expired_account`), ErrDenied},
	{regexp.MustCompile(`fail|error|infring|rar|too_big|unexpected|not_found|unsupported`), ErrFailed},
	{regexp.MustCompile(`download|cach|queue|wait|processing|progress`), ErrCaching},
}

// notice names what a notice video at u says, by its file name: Torrentio
// sends /videos/downloading_v3.mp4, MediaFusion /static/exceptions/….mp4.
func notice(u *url.URL) error {
	name := strings.ToLower(strings.TrimSuffix(path.Base(u.Path), path.Ext(u.Path)))
	for _, n := range notices {
		if n.words.MatchString(name) {
			return n.err
		}
	}
	return ErrFailed
}

func mediaType(header string) string {
	kind, _, err := mime.ParseMediaType(header)
	if err != nil {
		return ""
	}
	return kind
}

// size is the whole file's, from Content-Range when the server took the
// range, or Content-Length when it sent the file; 0 when it doesn't say.
func size(resp *http.Response) int64 {
	if resp.StatusCode == http.StatusPartialContent {
		_, total, ok := strings.Cut(resp.Header.Get("Content-Range"), "/")
		if n, err := strconv.ParseInt(total, 10, 64); ok && err == nil {
			return n
		}
		return 0
	}
	return max(resp.ContentLength, 0)
}

// failure turns a transport error into one that names no URL: *url.Error
// quotes the whole request URL.
func failure(ctx context.Context, err error) error {
	switch {
	case errors.Is(context.Cause(ctx), ErrTimeout):
		return ErrTimeout
	case ctx.Err() != nil:
		return context.Canceled
	case errors.Is(err, ErrRedirects):
		return ErrRedirects
	}
	return ErrUnreachable
}

// MarshalError gives the frontend a code for each error, never its text.
func MarshalError(err error) []byte {
	code := CodeUnreachable
	for _, known := range []struct {
		err  error
		code string
	}{
		{ErrInvalidURL, CodeInvalidURL}, {ErrTimeout, CodeTimeout},
		{ErrRedirects, CodeRedirects}, {ErrExpired, CodeExpired}, {ErrBusy, CodeBusy},
		{ErrUnavailable, CodeUnavailable}, {ErrNotVideo, CodeNotVideo},
		{ErrCaching, CodeCaching}, {ErrDenied, CodeDenied}, {ErrFailed, CodeFailed},
	} {
		if errors.Is(err, known.err) {
			code = known.code
			break
		}
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}
