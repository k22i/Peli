package nuvio

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// A custom server (#34) is a self-hosted Nuvio backend, such as
// NuvioMedia/self-host: the same Supabase functions at another URL. Its key
// is read from its discovery document like Nuvio's, or given by the user when
// the server has none.

// ServerURL returns the URL of the backend the client calls.
func (c *Client) ServerURL() string {
	base, _ := c.server()
	return base
}

// UseServer points the client at the backend at baseURL from the next
// request on, with key as its publishable key, or "" to read the key from
// the backend's discovery document. Requests already sent finish where they
// were going. A session from one backend means nothing to another: sign out
// first.
func (c *Client) UseServer(baseURL, key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.baseURL, c.key = strings.TrimRight(baseURL, "/"), key
}

// CheckServer checks that baseURL is a Nuvio backend that takes key, or the
// key its discovery document publishes when key is "". It reads the public
// avatar catalog, which needs no session and writes nothing, so it also
// shows the backend has Nuvio's functions. The client keeps calling its own
// backend.
//
// It returns ErrNotNuvio, ErrKeyRefused, or the error any call would
// (ErrUnreachable, ErrUnavailable, ErrRateLimited).
func (c *Client) CheckServer(ctx context.Context, baseURL, key string) error {
	probe := &Client{
		userAgent: c.userAgent, http: c.http, retries: c.retries, backoff: c.backoff,
		sleep: c.sleep, limiter: c.limiter, originID: c.originID, home: c.home,
		baseURL: strings.TrimRight(baseURL, "/"), key: key,
	}
	_, err := probe.AvatarCatalog(ctx)
	switch {
	case err == nil, errors.Is(err, ErrNotNuvio), errors.Is(err, ErrUnreachable),
		errors.Is(err, ErrUnavailable), errors.Is(err, ErrRateLimited), ctx.Err() != nil:
		return err
	// No session was sent, so a 401 is the key.
	case errors.Is(err, ErrSignedOut):
		return fmt.Errorf("%w: %v", ErrKeyRefused, err)
	}
	// A 404 (no discovery document, or no get_avatar_catalog), or a web page
	// where JSON was expected.
	return fmt.Errorf("%w: %v", ErrNotNuvio, err)
}

// ParseServerURL checks that raw is a backend's address, http or https with
// a host and nothing after the path, and returns it without a trailing
// slash. http is allowed for a server on the user's own network.
func ParseServerURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("nuvio: %q is not a server address", raw)
	}
	u.Host = strings.ToLower(u.Host)
	return strings.TrimRight(u.String(), "/"), nil
}
