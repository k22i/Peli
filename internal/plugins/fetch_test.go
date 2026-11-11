package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// site is a test server that echoes what it was asked.
func site(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Add("Set-Cookie", "a=1; Path=/")
		w.Header().Add("X-Many", "one")
		w.Header().Add("X-Many", "two")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method": r.Method, "ua": r.UserAgent(), "referer": r.Referer(), "type": r.Header.Get("Content-Type"),
			"body": string(body), "cookie": r.Header.Get("Cookie"), "query": r.URL.RawQuery,
		})
	})
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/echo?from=redirect", http.StatusFound)
	})
	mux.HandleFunc("/big", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 2<<20)))
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<ul><li><a href="https://cdn.test/1.m3u8">One</a></li><li><a href="https://cdn.test/2.m3u8">Two</a></li></ul>`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// fetchJS runs body with `base` set to the server's URL.
func fetchJS(t *testing.T, server *httptest.Server, body string) string {
	t.Helper()
	return evalJS(t, `const base = `+fmt.Sprintf("%q", server.URL)+`;`+body)
}

func TestFetch(t *testing.T) {
	server := site(t)
	got := fetchJS(t, server, `
		return fetch(base + "/echo?x=1", { headers: { Referer: "https://site.test/" } }).then(r =>
			r.json().then(j => ({
				ok: r.ok, status: r.status, type: r.headers.get("content-type"), many: r.headers.get("x-many"),
				redirected: r.redirected, ua: j.ua, referer: j.referer, query: j.query, method: j.method,
			})));`)
	want := `{"ok":true,"status":200,"type":"application/json","many":"one, two","redirected":false,` +
		`"ua":"Peli/test","referer":"https://site.test/","query":"x=1","method":"GET"}`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestFetchBodies(t *testing.T) {
	server := site(t)
	got := fetchJS(t, server, `
		const ask = (body, headers) => fetch(base + "/echo", { method: "post", body, headers }).then(r => r.json()).then(j => [j.method, j.type, j.body]);
		const form = new FormData();
		form.append("a", "1");
		return Promise.all([
			ask(new URLSearchParams({ q: "x y" })),
			ask(JSON.stringify({ a: 1 }), { "Content-Type": "application/json" }),
			ask("plain"),
			ask(new TextEncoder().encode("bytes")),
			ask(form).then(([m, type, body]) => [m, type.split(";")[0], body.includes('name="a"')]),
		]);`)
	want := `[["POST","application/x-www-form-urlencoded;charset=UTF-8","q=x+y"],["POST","application/json","{\"a\":1}"],` +
		`["POST","text/plain;charset=UTF-8","plain"],["POST","","bytes"],["POST","multipart/form-data",true]]`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestFetchRedirects(t *testing.T) {
	server := site(t)
	got := fetchJS(t, server, `return Promise.all([
		fetch(base + "/redirect").then(r => r.json().then(j => [r.status, r.redirected, r.url.endsWith("/echo?from=redirect"), j.query])),
		fetch(base + "/redirect", { redirect: "manual" }).then(r => [r.status, r.headers.get("location")]),
		fetch(base + "/redirect", { redirect: "error" }).then(() => "followed", e => e.name),
	]);`)
	if want := `[[200,true,true,"from=redirect"],[302,"/echo?from=redirect"],"TypeError"]`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

// Cookies a site sets come back to it within the call.
func TestFetchCookies(t *testing.T) {
	server := site(t)
	got := fetchJS(t, server, `return fetch(base + "/echo").then(r => { const first = r.headers.getSetCookie(); return fetch(base + "/echo").then(r => r.json()).then(j => [first, j.cookie]); });`)
	if want := `[["a=1; Path=/"],"a=1"]`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestFetchText(t *testing.T) {
	server := site(t)
	got := fetchJS(t, server, `
		const cheerio = require("cheerio-without-node-native");
		return fetch(base + "/page").then(r => r.text()).then(html => {
			const $ = cheerio.load(html);
			return $("li a").map((i, a) => $(a).attr("href")).get();
		});`)
	if want := `["https://cdn.test/1.m3u8","https://cdn.test/2.m3u8"]`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestFetchBodyUsedOnce(t *testing.T) {
	server := site(t)
	got := fetchJS(t, server, `return fetch(base + "/echo").then(r => {
		const copy = r.clone();
		return r.text().then(() => r.text()).then(() => "twice", e => e.name).then(second => copy.json().then(j => [second, j.method]));
	});`)
	if want := `["TypeError","GET"]`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestFetchLimits(t *testing.T) {
	server := site(t)
	got := fetchJS(t, server, `
		const outcome = (p) => p.then(() => "ok", e => e.name + ": " + e.message);
		return Promise.all([
			outcome(fetch(base + "/big").then(r => r.text())),
			outcome(fetch("file:///etc/passwd")),
			outcome(fetch("ftp://example.com/")),
		]);`)
	var out []string
	if err := json.Unmarshal([]byte(got), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out[0], "too large") || !strings.Contains(out[1], "http and https") || !strings.Contains(out[2], "http and https") {
		t.Errorf("got %q", out)
	}

	// The call's share of requests.
	got = fetchJS(t, server, `
		const all = Array.from({ length: 25 }, () => fetch(base + "/echo").then(() => "ok", e => e.message));
		return Promise.all(all).then(r => r.filter(x => x !== "ok").length);`)
	if got != "5" {
		t.Errorf("over the limit: %s, want 5 refused", got)
	}
}

func TestFetchAbort(t *testing.T) {
	server := site(t)
	start := time.Now()
	got := fetchJS(t, server, `
		const c = new AbortController();
		setTimeout(() => c.abort(), 20);
		return Promise.all([
			fetch(base + "/slow", { signal: c.signal }).then(() => "finished", e => e.name),
			fetch(base + "/echo", { signal: AbortSignal.abort() }).then(() => "finished", e => e.name),
		]);`)
	if want := `["AbortError","AbortError"]`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("abort took %v", took)
	}
}

// Without PrivateNetwork, the sandbox can't reach loopback: not the test
// server, not Peli's own torrent link.
func TestFetchRefusesPrivateNetwork(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer server.Close()
	limits := testLimits
	limits.PrivateNetwork = false
	code := `module.exports.getStreams = () => fetch(` + fmt.Sprintf("%q", server.URL) + `).then(
		() => [{ url: "https://a.test/", title: "reached" }],
		(e) => [{ url: "https://a.test/", title: e.message }]);`
	streams, err := runCode(t, code, movie, limits)
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 0 || !strings.Contains(streams[0].Title, "can't be fetched") {
		t.Errorf("hits %d, answer %q", hits.Load(), streams[0].Title)
	}
}

func TestPublic(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8": true, "1.1.1.1": true, "2606:4700:4700::1111": true,
		"127.0.0.1": false, "::1": false, "10.0.0.1": false, "172.16.5.4": false, "192.168.1.1": false,
		"169.254.169.254": false, "100.100.100.100": false, "0.0.0.0": false, "::": false,
		"fc00::1": false, "fe80::1": false, "::ffff:127.0.0.1": false, "::ffff:192.168.0.1": false,
		"224.0.0.1": false, "255.255.255.255": false, "2002:c0a8:0101::1": false, "64:ff9b::7f00:1": false,
	} {
		if got := public(netip.MustParseAddr(addr)); got != want {
			t.Errorf("public(%s) = %v, want %v", addr, got, want)
		}
	}
}

func TestBlockedDialError(t *testing.T) {
	f := newFetcher(Limits{Requests: 1, Body: 1 << 10}, "Peli/test")
	res := f.do(t.Context(), fetchRequest{URL: "http://127.0.0.1:1/", Method: "GET"})
	if res.err == nil || !strings.Contains(res.err.Error(), "can't be fetched") {
		t.Errorf("got %v", res.err)
	}
	if errors.Is(res.err, errBlocked) {
		t.Error("the error names the address check, not the address")
	}
}
