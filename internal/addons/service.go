// Package addons fetches from Stremio addons for the webview when its own
// fetch can't: an addon that sends no CORS headers, or an error page without
// them (#37). The typed client in frontend/src/lib/addon-protocol tries the
// webview first and falls back to Fetch; it parses every answer itself.
//
// An addon URL can carry the user's config, debrid keys included, so no URL
// is logged or put in an error.
package addons

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

var (
	// ErrInvalidURL means the URL isn't an absolute http or https URL.
	ErrInvalidURL = errors.New("addons: not an http or https URL")
	// ErrUnreachable means the addon couldn't be reached: no network, DNS,
	// TLS or a dropped connection.
	ErrUnreachable = errors.New("addons: addon unreachable")
	// ErrTimeout means the addon didn't answer within MaxWait.
	ErrTimeout = errors.New("addons: addon didn't answer")
	// ErrTooLarge means the answer was bigger than MaxBody.
	ErrTooLarge = errors.New("addons: answer too large")
)

// Error codes the frontend reads (MarshalError).
const (
	CodeInvalidURL  = "invalid_url"
	CodeUnreachable = "unreachable"
	CodeTimeout     = "timeout"
	CodeTooLarge    = "too_large"
)

const (
	// MaxWait caps one fetch. The frontend sets its own, shorter timeout per
	// resource and cancels the call; this only stops a forgotten one.
	MaxWait = 2 * time.Minute
	// MaxBody caps an answer. Comet's ~1,400 streams for a popular title are
	// under 2 MB (#6).
	MaxBody = 32 << 20
)

// Response is an addon's answer, passed on whatever its status.
type Response struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// Service is the Wails service the frontend calls for addon requests.
type Service struct {
	http      *http.Client
	userAgent string
	maxWait   time.Duration
}

// NewService returns a Service that sends version in its User-Agent.
func NewService(version string) *Service {
	return &Service{
		http:      &http.Client{},
		userAgent: fmt.Sprintf("Sinag/%s (+https://github.com/k22i/Sinag)", version),
		maxWait:   MaxWait,
	}
}

// Fetch GETs rawURL and returns its status and body. Cancelling the call in
// the frontend cancels the request.
func (s *Service) Fetch(ctx context.Context, rawURL string) (Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return Response{}, ErrInvalidURL
	}
	ctx, cancel := context.WithTimeoutCause(ctx, s.maxWait, ErrTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Response{}, ErrInvalidURL
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", s.userAgent)

	resp, err := s.http.Do(req)
	if err != nil {
		return Response{}, failure(ctx)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxBody+1))
	if err != nil {
		return Response{}, failure(ctx)
	}
	if len(body) > MaxBody {
		return Response{}, ErrTooLarge
	}
	return Response{Status: resp.StatusCode, Body: string(body)}, nil
}

// failure turns a transport error into one that names no URL: *url.Error
// quotes the whole request URL.
func failure(ctx context.Context) error {
	if errors.Is(context.Cause(ctx), ErrTimeout) {
		return ErrTimeout
	}
	if ctx.Err() != nil {
		return context.Canceled
	}
	return ErrUnreachable
}

// MarshalError gives the frontend a code for each error, never its text.
func MarshalError(err error) []byte {
	code := CodeUnreachable
	switch {
	case errors.Is(err, ErrInvalidURL):
		code = CodeInvalidURL
	case errors.Is(err, ErrTimeout):
		code = CodeTimeout
	case errors.Is(err, ErrTooLarge):
		code = CodeTooLarge
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}
