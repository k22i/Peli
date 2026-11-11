package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// The test binary is also the sandbox: Runner starts it with ChildEnv.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "crash" {
		os.Exit(2)
	}
	ServeChild()
	os.Exit(m.Run())
}

var testLimits = Limits{
	Timeout:        5 * time.Second,
	Memory:         128 << 20,
	Requests:       20,
	Body:           1 << 20,
	Streams:        100,
	PrivateNetwork: true,
}

// runCode calls code in this process, as the child would.
func runCode(t *testing.T, code string, query Query, limits Limits) ([]Stream, error) {
	t.Helper()
	ctx, cancel := context.WithTimeoutCause(context.Background(), limits.Timeout, ErrTimeout)
	defer cancel()
	return run(ctx, Job{ID: "test", Code: code, Query: query, Limits: limits, UserAgent: "Peli/test"}, nil)
}

var movie = Query{TmdbID: "550", MediaType: "movie"}

// evalJS runs body (a function body that returns a value or a promise) in
// a sandbox and returns the value as JSON.
func evalJS(t *testing.T, body string) string {
	t.Helper()
	code := `module.exports = { getStreams: function () {
		return Promise.resolve((function () {` + body + `})()).then(function (v) {
			return [{ url: "https://result.test/", title: JSON.stringify(v === undefined ? null : v) }];
		});
	} };`
	streams, err := runCode(t, code, movie, testLimits)
	if err != nil {
		t.Fatalf("eval: %v", err)
	}
	if len(streams) != 1 {
		t.Fatalf("eval: %d streams", len(streams))
	}
	return streams[0].Title
}

func TestOfflineBundle(t *testing.T) {
	code, err := os.ReadFile("testdata/offline.js")
	if err != nil {
		t.Fatal(err)
	}
	streams, err := runCode(t, string(code), Query{TmdbID: "1396", MediaType: "tv", Season: 2, Episode: 3}, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	want := []Stream{
		{Name: "Offline", Title: "Fight Club 1080p ok", URL: "https://cdn.example.com/v/1?id=1396&s=2&e=3", Quality: "1080p", Headers: map[string]string{"Referer": "https://cdn.example.com/"}},
		{Name: "Offline", Title: "Fight Club 720p ok", URL: "https://cdn.example.com/v/2?id=1396&s=2&e=3", Quality: "720p", Headers: map[string]string{"Referer": "https://cdn.example.com/"}},
	}
	got, _ := json.Marshal(streams)
	exp, _ := json.Marshal(want)
	if string(got) != string(exp) {
		t.Errorf("streams\n got %s\nwant %s", got, exp)
	}
}

func TestArguments(t *testing.T) {
	code := `module.exports.getStreams = function (id, type, season, episode) {
		return [{ url: "https://a.test/", title: JSON.stringify([id, type, season, episode]) }];
	};`
	for _, tc := range []struct {
		query Query
		want  string
	}{
		{movie, `["550","movie",null,null]`},
		{Query{TmdbID: "1396", MediaType: "tv", Season: 1, Episode: 5}, `["1396","tv",1,5]`},
	} {
		streams, err := runCode(t, code, tc.query, testLimits)
		if err != nil {
			t.Fatal(err)
		}
		if streams[0].Title != tc.want {
			t.Errorf("%+v: got %s, want %s", tc.query, streams[0].Title, tc.want)
		}
	}
}

// Plugins export getStreams in every way CommonJS and esbuild allow.
func TestExportShapes(t *testing.T) {
	answer := `[{ url: "https://a.test/" }]`
	for name, code := range map[string]string{
		"module.exports object":   `module.exports = { getStreams: async () => ` + answer + ` };`,
		"exports property":        `exports.getStreams = () => Promise.resolve(` + answer + `);`,
		"module.exports function": `module.exports = function () { return ` + answer + `; };`,
		"default export":          `module.exports = { default: { getStreams: () => ` + answer + ` } };`,
		"global only":             `globalThis.getStreams = function () { return ` + answer + `; };`,
		"top-level function":      `async function getStreams() { return ` + answer + `; } global.getStreams = getStreams;`,
	} {
		t.Run(name, func(t *testing.T) {
			streams, err := runCode(t, code, movie, testLimits)
			if err != nil {
				t.Fatal(err)
			}
			if len(streams) != 1 {
				t.Fatalf("got %d streams", len(streams))
			}
		})
	}
}

func TestFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		code string
		want error
		msg  string
	}{
		{"syntax error", `module.exports = {`, ErrInvalidPlugin, ""},
		{"no getStreams", `module.exports = { other: 1 };`, ErrInvalidPlugin, "getStreams"},
		{"throws at load", `throw new Error("broken at load");`, ErrFailed, "broken at load"},
		{"throws", `module.exports.getStreams = () => { throw new TypeError("nope"); };`, ErrFailed, "TypeError: nope"},
		{"rejects", `module.exports.getStreams = () => Promise.reject(new Error("site down"));`, ErrFailed, "site down"},
		{"rejects with a string", `module.exports.getStreams = () => Promise.reject("plain");`, ErrFailed, "plain"},
		{"never settles", `module.exports.getStreams = () => new Promise(() => {});`, ErrStalled, ""},
		{"recursion", `function f() { return f() + 1; } module.exports.getStreams = () => f();`, ErrFailed, "recursion"},
		{"not a list", `module.exports.getStreams = () => 42;`, ErrBadAnswer, ""},
		{"cyclic", `module.exports.getStreams = () => { const a = []; a.push(a); return a; };`, ErrBadAnswer, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runCode(t, tc.code, movie, testLimits)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
			if tc.msg != "" && !strings.Contains(err.Error(), tc.msg) {
				t.Errorf("%q doesn't say %q", err, tc.msg)
			}
		})
	}
}

func TestTimeoutInterruptsLoop(t *testing.T) {
	limits := testLimits
	limits.Timeout = 300 * time.Millisecond
	start := time.Now()
	_, err := runCode(t, `module.exports.getStreams = () => { for (;;) {} };`, movie, limits)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("got %v, want ErrTimeout", err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("took %v to stop", took)
	}
	// A plugin waiting on a timer is stopped the same way.
	_, err = runCode(t, `module.exports.getStreams = () => new Promise(r => setTimeout(r, 60000));`, movie, limits)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("waiting: got %v, want ErrTimeout", err)
	}
}

// Nothing in the runtime reaches files, processes or the environment.
func TestNoFileOrProcessAccess(t *testing.T) {
	got := evalJS(t, `
		const out = {};
		for (const name of ["fs", "child_process", "os", "path", "net", "http", "https", "util", "process", "node:fs", "./local.js", "/etc/passwd"]) {
			try { require(name); out[name] = "loaded"; } catch (e) { out[name] = e.code || e.message; }
		}
		out.env = Object.keys(process.env);
		out.exit = typeof process.exit;
		out.binding = typeof process.binding;
		out.fsGlobal = typeof fs;
		out.xhr = typeof XMLHttpRequest;
		out.importScripts = typeof importScripts;
		out.load = typeof load;
		return out;`)
	var out map[string]any
	if err := json.Unmarshal([]byte(got), &out); err != nil {
		t.Fatal(err)
	}
	for name, v := range out {
		switch name {
		case "env":
			if b, _ := json.Marshal(v); string(b) != `["NODE_ENV"]` {
				t.Errorf("process.env has %s", b)
			}
		case "exit", "binding", "fsGlobal", "xhr", "importScripts", "load":
			if v != "undefined" {
				t.Errorf("%s is %v", name, v)
			}
		default:
			if v != "MODULE_NOT_FOUND" {
				t.Errorf("require(%q): %v", name, v)
			}
		}
	}
}

func TestRequireNames(t *testing.T) {
	got := evalJS(t, `return [
		typeof require("cheerio-without-node-native").load,
		typeof require("cheerio").load,
		typeof require("crypto-js").AES,
		typeof require("crypto-js/aes"),
		typeof require("buffer").Buffer,
		typeof require("url").URL,
		require("crypto-js") === require("crypto-js"),
	];`)
	if want := `["function","function","object","object","function","function",true]`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestGlobals(t *testing.T) {
	got := evalJS(t, `
		const u = new URL("/path?a=1&b=two", "https://example.com");
		const p = new URLSearchParams({ q: "fight club", page: 2 });
		const bytes = new TextEncoder().encode("héllo");
		const random = crypto.getRandomValues(new Uint8Array(8));
		return {
			url: u.href, host: u.hostname, b: u.searchParams.get("b"), params: p.toString(),
			atob: atob("aGVsbG8="), btoa: btoa("hello"), bytes: bytes.length,
			decoded: new TextDecoder().decode(bytes), latin1: new TextDecoder("latin1").decode(new Uint8Array([0xe9])),
			buffer: Buffer.from("aGk=", "base64").toString("utf8"), hex: Buffer.from("hi").toString("hex"),
			random: random.length, uuid: /^[0-9a-f-]{36}$/.test(crypto.randomUUID()),
			subtle: typeof crypto.subtle, settings: typeof SCRAPER_SETTINGS, id: SCRAPER_ID,
			self: self === globalThis && global === globalThis,
		};`)
	want := `{"url":"https://example.com/path?a=1&b=two","host":"example.com","b":"two","params":"q=fight+club&page=2",` +
		`"atob":"hello","btoa":"aGVsbG8=","bytes":6,"decoded":"héllo","latin1":"é","buffer":"hi","hex":"6869",` +
		`"random":8,"uuid":true,"subtle":"undefined","settings":"object","id":"test","self":true}`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestTimers(t *testing.T) {
	got := evalJS(t, `return new Promise((resolve) => {
		const order = [];
		setTimeout((a, b) => order.push("timeout " + a + b), 20, "x", "y");
		const cancelled = setTimeout(() => order.push("cancelled"), 5);
		clearTimeout(cancelled);
		let n = 0;
		const tick = setInterval(() => { order.push("tick"); if (++n === 3) clearInterval(tick); }, 1);
		queueMicrotask(() => order.push("micro"));
		setTimeout(() => resolve(order), 60);
	});`)
	if want := `["micro","tick","tick","tick","timeout xy"]`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestAbortController(t *testing.T) {
	got := evalJS(t, `
		const c = new AbortController();
		const seen = [];
		c.signal.addEventListener("abort", () => seen.push("listener"));
		c.signal.onabort = () => seen.push("onabort");
		c.abort();
		let thrown;
		try { c.signal.throwIfAborted(); } catch (e) { thrown = e.name; }
		return { aborted: c.signal.aborted, seen, thrown, already: AbortSignal.abort().aborted };`)
	if want := `{"aborted":true,"seen":["onabort","listener"],"thrown":"AbortError","already":true}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

// What a plugin answers is cleaned before it leaves the sandbox.
func TestAnswerCleaning(t *testing.T) {
	code := `module.exports.getStreams = () => [
		{ name: "Site", title: "Film", url: "https://cdn.test/a.m3u8", quality: "1080p", size: 1610612736,
		  headers: { Referer: "https://site.test/", "Bad Header": "x", Origin: 5, "X-Split": "a\r\nInjected: 1" } },
		{ name: "Copy", url: "https://cdn.test/a.m3u8" },
		{ url: "magnet:?xt=urn:btih:abc" },
		{ url: "javascript:alert(1)" },
		{ url: "/relative" },
		{ title: "no url" },
		null, 7, "text",
		{ url: " https://cdn.test/b.mp4 ", description: "From description", size: "700 MB", quality: 720 },
	];`
	streams, err := runCode(t, code, movie, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(streams)
	want := `[{"name":"Site","title":"Film","url":"https://cdn.test/a.m3u8","quality":"1080p","size":"1.5 GB","headers":{"Referer":"https://site.test/"}},` +
		`{"name":"","title":"From description","url":"https://cdn.test/b.mp4","quality":"720","size":"700 MB"}]`
	if string(got) != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestAnswerShapes(t *testing.T) {
	for name, tc := range map[string]struct {
		answer string
		count  int
	}{
		"nothing":       {"undefined", 0},
		"null":          {"null", 0},
		"empty":         {"[]", 0},
		"streams field": {`({ streams: [{ url: "https://a.test/" }] })`, 1},
	} {
		t.Run(name, func(t *testing.T) {
			streams, err := runCode(t, `module.exports.getStreams = async () => `+tc.answer+`;`, movie, testLimits)
			if err != nil {
				t.Fatal(err)
			}
			if len(streams) != tc.count || streams == nil {
				t.Errorf("got %v", streams)
			}
		})
	}
}

func TestStreamLimit(t *testing.T) {
	limits := testLimits
	limits.Streams = 3
	streams, err := runCode(t, `module.exports.getStreams = () =>
		Array.from({ length: 10 }, (_, i) => ({ url: "https://a.test/" + i }));`, movie, limits)
	if err != nil {
		t.Fatal(err)
	}
	if len(streams) != 3 {
		t.Errorf("got %d streams, want 3", len(streams))
	}
}

// The plugin can't swap JSON.stringify to change what Peli reads.
func TestAnswerReadWithOriginalJSON(t *testing.T) {
	streams, err := runCode(t, `JSON.stringify = () => '[{"url":"https://evil.test/"}]';
		module.exports.getStreams = () => [{ url: "https://good.test/" }];`, movie, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	if len(streams) != 1 || streams[0].URL != "https://good.test/" {
		t.Errorf("got %+v", streams)
	}
}
