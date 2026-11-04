package plugins

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dop251/goja"
)

const (
	// maxRedirects caps a followed fetch, as browsers do.
	maxRedirects = 20
	// maxFetches caps the fetches in flight at once in one call.
	maxFetches = 8
	// requestTimeout caps one fetch, inside the call's own limit.
	requestTimeout = 30 * time.Second
)

var errBlocked = errors.New("address not allowed")

// fetcher makes a plugin's requests: the only way out of the sandbox. Each
// call has its own cookies, kept for that call only, as a plugin may log in
// to a site and then ask for its pages. Loopback, private, link-local and
// other special addresses are refused at dial time, after DNS, so a name
// can't point a plugin at the user's network.
type fetcher struct {
	client    *http.Client
	userAgent string
	body      int64
	requests  int
	slots     chan struct{}

	mu   sync.Mutex
	made int
}

type redirectMode struct{}

func newFetcher(limits Limits, userAgent string) *fetcher {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	if !limits.PrivateNetwork {
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			addr, err := netip.ParseAddr(host)
			if err != nil || !public(addr) {
				return errBlocked
			}
			return nil
		}
	}
	jar, _ := cookiejar.New(nil)
	transport := &http.Transport{
		// No proxy: the sandbox's environment is empty, and a proxy on
		// loopback would get round the address check.
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: requestTimeout,
	}
	return &fetcher{
		client: &http.Client{
			Transport: transport,
			Jar:       jar,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				switch req.Context().Value(redirectMode{}) {
				case "manual":
					return http.ErrUseLastResponse
				case "error":
					return errors.New("redirect not allowed")
				}
				if len(via) >= maxRedirects {
					return errors.New("too many redirects")
				}
				return nil
			},
		},
		userAgent: userAgent,
		body:      limits.Body,
		requests:  limits.Requests,
		slots:     make(chan struct{}, maxFetches),
	}
}

// public is whether addr is on the public internet.
func public(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() || addr.IsMulticast() ||
		addr.IsUnspecified() {
		return false
	}
	for _, p := range specialPrefixes {
		if p.Contains(addr) {
			return false
		}
	}
	return true
}

// Ranges netip doesn't call private but that aren't the public internet:
// "this network", carrier-grade NAT (Tailscale lives here), IETF protocol
// assignments, benchmarking, the reserved block, NAT64 and 6to4 (which can
// embed a private IPv4 address), and the documentation ranges.
var specialPrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"64:ff9b::/96", "64:ff9b:1::/48", "2001:db8::/32", "2002::/16", "100::/64",
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// fetchRequest is what the prelude's fetch hands the host.
type fetchRequest struct {
	URL      string
	Method   string
	Headers  [][2]string
	Body     []byte
	Redirect string
}

// fetchResult is what comes back, before it becomes a JS object.
type fetchResult struct {
	status     int
	statusText string
	url        string
	redirected bool
	headers    [][2]string
	body       []byte
	err        error
	aborted    bool
}

// take counts one more request, or says the call has made its share.
func (f *fetcher) take() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.made >= f.requests {
		return false
	}
	f.made++
	return true
}

func (f *fetcher) do(ctx context.Context, r fetchRequest) fetchResult {
	u, err := url.Parse(r.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fetchResult{err: fmt.Errorf("only http and https URLs can be fetched")}
	}
	if !f.take() {
		return fetchResult{err: fmt.Errorf("too many requests: the limit is %d a call", f.requests)}
	}
	select {
	case f.slots <- struct{}{}:
		defer func() { <-f.slots }()
	case <-ctx.Done():
		return fetchResult{aborted: true}
	}

	ctx, cancel := context.WithTimeout(context.WithValue(ctx, redirectMode{}, r.Redirect), requestTimeout)
	defer cancel()
	var body io.Reader
	if r.Body != nil {
		body = strings.NewReader(string(r.Body))
	}
	method := strings.ToUpper(strings.TrimSpace(r.Method))
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return fetchResult{err: err}
	}
	for _, h := range r.Headers {
		name := strings.TrimSpace(h[0])
		if name == "" || strings.EqualFold(name, "host") || strings.EqualFold(name, "content-length") {
			continue
		}
		if strings.EqualFold(name, "cookie") {
			// Kept as the plugin set it, alongside the call's own jar.
			req.Header.Add(name, h[1])
			continue
		}
		req.Header.Set(name, h[1])
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", f.userAgent)
	}
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "*/*")
	}

	resp, err := f.client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return fetchResult{aborted: true}
		}
		if errors.Is(err, errBlocked) {
			return fetchResult{err: errors.New("that address can't be fetched from a plugin")}
		}
		return fetchResult{err: errors.New("network request failed")}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, f.body+1))
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return fetchResult{aborted: true}
		}
		return fetchResult{err: errors.New("network request failed while reading the body")}
	}
	if int64(len(data)) > f.body {
		return fetchResult{err: fmt.Errorf("response too large: the limit is %d bytes", f.body)}
	}
	res := fetchResult{
		status:     resp.StatusCode,
		statusText: strings.TrimSpace(strings.TrimPrefix(resp.Status, fmt.Sprint(resp.StatusCode))),
		url:        resp.Request.URL.String(),
		redirected: resp.Request.URL.String() != u.String(),
		body:       data,
	}
	for name, values := range resp.Header {
		for _, v := range values {
			res.headers = append(res.headers, [2]string{strings.ToLower(name), v})
		}
	}
	return res
}

// installFetch adds host.fetch(request) → {promise, abort}. The prelude's
// fetch builds the request and the Response around it.
func (s *sandbox) installFetch(host *goja.Object) {
	host.Set("fetch", func(call goja.FunctionCall) goja.Value {
		vm := s.vm
		in := call.Argument(0).ToObject(vm)
		req := fetchRequest{
			URL:      in.Get("url").String(),
			Method:   stringOr(in.Get("method"), "GET"),
			Redirect: stringOr(in.Get("redirect"), "follow"),
		}
		if hs, ok := in.Get("headers").Export().([]any); ok {
			for _, h := range hs {
				if pair, ok := h.([]any); ok && len(pair) == 2 {
					req.Headers = append(req.Headers, [2]string{fmt.Sprint(pair[0]), fmt.Sprint(pair[1])})
				}
			}
		}
		switch b := in.Get("body").Export().(type) {
		case goja.ArrayBuffer:
			req.Body = append([]byte(nil), b.Bytes()...)
		case string:
			req.Body = []byte(b)
		}

		promise, resolve, reject := vm.NewPromise()
		ctx, cancel := context.WithCancel(s.ctx)
		back := s.loop.hold()
		go func() {
			res := s.fetcher.do(ctx, req)
			cancel()
			back(func() error {
				if res.aborted || res.err != nil {
					failure := vm.NewObject()
					if res.aborted {
						failure.Set("kind", "abort")
						failure.Set("message", "The operation was aborted.")
					} else {
						failure.Set("kind", "network")
						failure.Set("message", res.err.Error())
					}
					return reject(failure)
				}
				out := vm.NewObject()
				out.Set("status", res.status)
				out.Set("statusText", res.statusText)
				out.Set("url", res.url)
				out.Set("redirected", res.redirected)
				headers := make([]any, len(res.headers))
				for i, h := range res.headers {
					headers[i] = []any{h[0], h[1]}
				}
				out.Set("headers", headers)
				out.Set("body", vm.NewArrayBuffer(res.body))
				return resolve(out)
			})
		}()
		out := vm.NewObject()
		out.Set("promise", promise)
		out.Set("abort", func() { cancel() })
		return out
	})
}

func stringOr(v goja.Value, fallback string) string {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return fallback
	}
	return v.String()
}
