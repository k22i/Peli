package plugins

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/andybalholm/cascadia"
	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/buffer"
	nodeurl "github.com/dop251/goja_nodejs/url"
	"golang.org/x/net/http/httpguts"
	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/htmlindex"
	"golang.org/x/text/encoding/unicode"
)

// The JS half of the host API, ours: globals (fetch, timers, TextEncoder,
// AbortController…) and the two modules plugins require.
var (
	//go:embed js/prelude.js
	preludeJS string
	//go:embed js/cheerio.js
	cheerioJS string
	//go:embed js/crypto-js.js
	cryptoJS string
)

const (
	// maxCallDepth caps JS recursion: a StackOverflowError instead of the
	// sandbox's Go stack growing without end.
	maxCallDepth = 4_000
	// maxAnswer caps a plugin's answer as JSON.
	maxAnswer = 16 << 20
	// maxLog caps what one call may log.
	maxLog = 256 << 10
	// maxField caps a stream's text fields, in characters; maxURL its URL.
	maxField = 500
	maxURL   = 8 << 10
	// maxHeaders caps a stream's headers.
	maxHeaders = 32
)

// sandbox is one call of one plugin: a runtime with nothing but the host
// API in it. goja has no file, process or network access of its own, so
// what the host API gives is all a plugin can reach.
type sandbox struct {
	ctx       context.Context
	vm        *goja.Runtime
	loop      *loop
	fetcher   *fetcher
	selectors map[string]cascadia.Sel
	documents int
	logs      io.Writer
	logged    int
	stringify goja.Callable
}

// interrupted is what an interrupt carries: why the call was stopped.
type interrupted struct{ cause error }

// run calls the plugin in job and returns its streams. It stops when ctx
// ends, with ctx's cause (ErrTimeout, ErrMemory) as the error. Plugin logs
// go to logs.
func run(ctx context.Context, job Job, logs io.Writer) ([]Stream, error) {
	vm := goja.New()
	vm.SetFieldNameMapper(goja.UncapFieldNameMapper())
	vm.SetMaxCallStackSize(maxCallDepth)
	s := &sandbox{
		ctx:       ctx,
		vm:        vm,
		loop:      newLoop(vm),
		fetcher:   newFetcher(job.Limits, job.UserAgent),
		selectors: map[string]cascadia.Sel{},
		logs:      logs,
	}
	defer s.loop.stop()
	stop := context.AfterFunc(ctx, func() { vm.Interrupt(interrupted{context.Cause(ctx)}) })
	defer stop()

	if err := s.install(job); err != nil {
		return nil, s.failure(err)
	}
	getStreams, err := s.load(job.ID, job.Code)
	if err != nil {
		return nil, s.failure(err)
	}
	args := []goja.Value{vm.ToValue(job.Query.TmdbID), vm.ToValue(job.Query.MediaType), goja.Null(), goja.Null()}
	if job.Query.MediaType == "tv" {
		args[2], args[3] = vm.ToValue(job.Query.Season), vm.ToValue(job.Query.Episode)
	}
	answer, err := getStreams(goja.Undefined(), args...)
	if err != nil {
		return nil, s.failure(err)
	}
	if answer, err = s.await(ctx, answer); err != nil {
		return nil, err
	}
	return s.streams(answer, job.Limits.Streams)
}

// install puts the host API in the runtime.
func (s *sandbox) install(job Job) error {
	vm := s.vm
	host := vm.NewObject()
	s.installText(host)
	s.installTimers(host)
	s.installFetch(host)
	s.installHTML(host)
	s.installCrypto(host)

	// What the prelude hands out on require(): our two modules, and Node's
	// buffer and url from goja_nodejs (MIT; pure Go, no I/O).
	modules := vm.NewObject()
	lazy := func(name, source string) {
		modules.Set(name, func() (goja.Value, error) {
			v, err := vm.RunScript(name+".js", source)
			if err != nil {
				return nil, err
			}
			fn, _ := goja.AssertFunction(v)
			return fn(goja.Undefined(), host)
		})
	}
	lazy("cheerio-without-node-native", cheerioJS)
	lazy("crypto-js", cryptoJS)
	bufferModule := vm.NewObject()
	bufferModule.Set("exports", vm.NewObject())
	buffer.Require(vm, bufferModule)
	urlModule := vm.NewObject()
	urlModule.Set("exports", vm.NewObject())
	nodeurl.Require(vm, urlModule)
	modules.Set("buffer", func() goja.Value { return bufferModule.Get("exports") })
	modules.Set("url", func() goja.Value { return urlModule.Get("exports") })
	globals := vm.GlobalObject()
	globals.Set("Buffer", bufferModule.Get("exports").ToObject(vm).Get("Buffer"))
	globals.Set("URL", urlModule.Get("exports").ToObject(vm).Get("URL"))
	globals.Set("URLSearchParams", urlModule.Get("exports").ToObject(vm).Get("URLSearchParams"))

	settings := vm.ToValue(map[string]any{})
	if job.Settings != nil {
		settings = vm.ToValue(job.Settings)
	}
	globals.Set("SCRAPER_ID", job.ID)
	globals.Set("SCRAPER_SETTINGS", settings)

	prelude, err := vm.RunScript("prelude.js", preludeJS)
	if err != nil {
		return err
	}
	fn, _ := goja.AssertFunction(prelude)
	require, err := fn(goja.Undefined(), host, modules)
	if err != nil {
		return err
	}
	globals.Set("require", require)
	// Kept before the plugin runs, so it can't swap them.
	s.stringify, _ = goja.AssertFunction(globals.Get("JSON").ToObject(vm).Get("stringify"))
	return nil
}

// load runs the plugin's code as a CommonJS module and returns its
// getStreams: module.exports.getStreams, module.exports itself, the
// default export's, or a global one (bundles set all of these).
func (s *sandbox) load(id, code string) (goja.Callable, error) {
	vm := s.vm
	name := "plugin.js"
	if id != "" {
		name = id + ".js"
	}
	program, err := goja.Compile(name, "(function (exports, require, module) {"+code+"\n})", false)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidPlugin, firstLine(err.Error()))
	}
	wrapper, err := vm.RunProgram(program)
	if err != nil {
		return nil, err
	}
	fn, _ := goja.AssertFunction(wrapper)
	module := vm.NewObject()
	exports := vm.NewObject()
	module.Set("exports", exports)
	module.Set("id", name)
	if _, err := fn(exports, exports, vm.Get("require"), module); err != nil {
		return nil, err
	}
	candidates := []goja.Value{}
	if out := module.Get("exports"); out != nil && !goja.IsUndefined(out) && !goja.IsNull(out) {
		candidates = append(candidates, out)
		if o, ok := out.(*goja.Object); ok {
			candidates = append(candidates, o.Get("getStreams"))
			if d, ok := o.Get("default").(*goja.Object); ok {
				candidates = append(candidates, d.Get("getStreams"), d)
			}
		}
	}
	candidates = append(candidates, vm.GlobalObject().Get("getStreams"))
	for _, c := range candidates {
		if c == nil {
			continue
		}
		if fn, ok := goja.AssertFunction(c); ok {
			return fn, nil
		}
	}
	return nil, fmt.Errorf("%w: it doesn't export getStreams", ErrInvalidPlugin)
}

// await runs the loop until answer, if it's a promise, settles.
func (s *sandbox) await(ctx context.Context, answer goja.Value) (goja.Value, error) {
	promise, ok := answer.Export().(*goja.Promise)
	if !ok {
		return answer, nil
	}
	err := s.loop.run(ctx, func() bool { return promise.State() != goja.PromiseStatePending })
	if err != nil {
		return nil, s.failure(err)
	}
	if promise.State() == goja.PromiseStateRejected {
		return nil, fmt.Errorf("%w: %s", ErrFailed, describe(s.vm, promise.Result()))
	}
	return promise.Result(), nil
}

// failure turns what stopped the call into one of the package's errors.
func (s *sandbox) failure(err error) error {
	var (
		interrupt *goja.InterruptedError
		exception *goja.Exception
		overflow  *goja.StackOverflowError
		syntax    *goja.CompilerSyntaxError
		limit     *limitError
	)
	switch {
	case errors.As(err, &interrupt):
		if why, ok := interrupt.Value().(interrupted); ok && why.cause != nil {
			return why.cause
		}
		return ErrTimeout
	case errors.As(err, &overflow):
		return fmt.Errorf("%w: too much recursion", ErrFailed)
	case errors.As(err, &syntax):
		return fmt.Errorf("%w: %s", ErrInvalidPlugin, firstLine(syntax.Error()))
	case errors.As(err, &exception):
		return fmt.Errorf("%w: %s", ErrFailed, describe(s.vm, exception.Value()))
	case errors.As(err, &limit):
		return fmt.Errorf("%w: %s", ErrFailed, limit.msg)
	case errors.Is(err, ErrStalled), errors.Is(err, ErrInvalidPlugin), errors.Is(err, ErrTimeout),
		errors.Is(err, ErrMemory), errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		if errors.Is(err, context.DeadlineExceeded) {
			return ErrTimeout
		}
		return err
	}
	return fmt.Errorf("%w: %s", ErrFailed, firstLine(err.Error()))
}

// describe is a thrown value as a short message: an Error's message, or
// the value itself.
func describe(vm *goja.Runtime, v goja.Value) string {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return "no reason given"
	}
	if o, ok := v.(*goja.Object); ok {
		if m := o.Get("message"); m != nil && !goja.IsUndefined(m) {
			name := o.Get("name")
			if name != nil && !goja.IsUndefined(name) && name.String() != "" {
				return truncate(name.String()+": "+m.String(), 300)
			}
			return truncate(m.String(), 300)
		}
	}
	return truncate(firstLine(v.String()), 300)
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return truncate(s, 300)
}

// truncate cuts s to n characters.
func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// rawStream is a stream as a plugin answers it: any type in any field.
type rawStream struct {
	Name        any `json:"name"`
	Title       any `json:"title"`
	Description any `json:"description"`
	URL         any `json:"url"`
	Quality     any `json:"quality"`
	Size        any `json:"size"`
	Headers     any `json:"headers"`
}

// streams checks a plugin's answer and keeps its usable streams, at most
// max: an http or https URL, text fields cut to length, headers that are
// valid headers. A plugin may answer a list or {streams: [...]}; nothing
// (undefined, null) is no streams.
func (s *sandbox) streams(answer goja.Value, max int) ([]Stream, error) {
	if answer == nil || goja.IsUndefined(answer) || goja.IsNull(answer) {
		return []Stream{}, nil
	}
	encoded, err := s.stringify(goja.Undefined(), answer)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrBadAnswer, describeErr(s, err))
	}
	text := encoded.String()
	if len(text) > maxAnswer {
		return nil, fmt.Errorf("%w: answer too large", ErrBadAnswer)
	}
	var list []json.RawMessage
	if err := json.Unmarshal([]byte(text), &list); err != nil {
		var wrapped struct {
			Streams []json.RawMessage `json:"streams"`
		}
		if json.Unmarshal([]byte(text), &wrapped) != nil || wrapped.Streams == nil {
			return nil, fmt.Errorf("%w: not a list of streams", ErrBadAnswer)
		}
		list = wrapped.Streams
	}
	if max <= 0 {
		max = DefaultLimits.Streams
	}
	out := []Stream{}
	seen := map[string]bool{}
	for _, item := range list {
		var raw rawStream
		if json.Unmarshal(item, &raw) != nil {
			continue
		}
		stream, ok := clean(raw)
		if !ok || seen[stream.URL] {
			continue
		}
		seen[stream.URL] = true
		out = append(out, stream)
		if len(out) == max {
			break
		}
	}
	return out, nil
}

func describeErr(s *sandbox, err error) string {
	var exception *goja.Exception
	if errors.As(err, &exception) {
		return describe(s.vm, exception.Value())
	}
	return firstLine(err.Error())
}

func clean(raw rawStream) (Stream, bool) {
	link, ok := raw.URL.(string)
	link = strings.TrimSpace(link)
	if !ok || link == "" || len(link) > maxURL {
		return Stream{}, false
	}
	u, err := url.Parse(link)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return Stream{}, false
	}
	stream := Stream{
		Name:    field(raw.Name),
		Title:   field(raw.Title),
		URL:     link,
		Quality: field(raw.Quality),
		Size:    sizeText(raw.Size),
	}
	if stream.Title == "" {
		stream.Title = field(raw.Description)
	}
	if headers, ok := raw.Headers.(map[string]any); ok {
		for name, value := range headers {
			v, ok := value.(string)
			if !ok || !httpguts.ValidHeaderFieldName(name) || !httpguts.ValidHeaderFieldValue(v) {
				continue
			}
			if stream.Headers == nil {
				stream.Headers = map[string]string{}
			}
			if len(stream.Headers) < maxHeaders {
				stream.Headers[name] = v
			}
		}
	}
	return stream, true
}

// field is a text field: a string or a number, trimmed and cut to length.
func field(v any) string {
	switch t := v.(type) {
	case string:
		return truncate(strings.TrimSpace(t), maxField)
	case float64:
		return fmt.Sprint(t)
	}
	return ""
}

// sizeText is a size as text: plugins mostly send "2.5 GB", some a number
// of bytes.
func sizeText(v any) string {
	if n, ok := v.(float64); ok {
		if n <= 0 || math.IsInf(n, 0) || math.IsNaN(n) {
			return ""
		}
		units := []string{"B", "KB", "MB", "GB", "TB"}
		i := 0
		for n >= 1024 && i < len(units)-1 {
			n /= 1024
			i++
		}
		return strings.TrimSuffix(strings.TrimSuffix(fmt.Sprintf("%.2f", n), "0"), ".0") + " " + units[i]
	}
	return field(v)
}

// installText adds base64, UTF-8 and other text encodings, and logging.
func (s *sandbox) installText(host *goja.Object) {
	vm := s.vm
	host.Set("atob", func(text string) (string, error) {
		clean := strings.Map(func(r rune) rune {
			if r == ' ' || r == '\t' || r == '\n' || r == '\f' || r == '\r' {
				return -1
			}
			return r
		}, text)
		if len(clean)%4 == 1 {
			return "", errors.New("InvalidCharacterError: the string to be decoded is not correctly encoded")
		}
		data, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(clean, "="))
		if err != nil {
			return "", errors.New("InvalidCharacterError: the string to be decoded is not correctly encoded")
		}
		return latin1(data), nil
	})
	host.Set("btoa", func(text string) (string, error) {
		data := make([]byte, 0, len(text))
		for _, r := range text {
			if r > 0xff {
				return "", errors.New("InvalidCharacterError: the string to be encoded contains characters outside of the Latin1 range")
			}
			data = append(data, byte(r))
		}
		return base64.StdEncoding.EncodeToString(data), nil
	})
	host.Set("encodeUTF8", func(text string) goja.Value {
		return vm.ToValue(vm.NewArrayBuffer([]byte(text)))
	})
	host.Set("checkEncoding", func(label string) error {
		_, err := decoder(label)
		return err
	})
	host.Set("decode", func(data goja.ArrayBuffer, label string, fatal bool) (string, error) {
		b := data.Bytes()
		enc, err := decoder(label)
		if err != nil {
			return "", err
		}
		if enc == nil { // UTF-8
			b = trimBOM(b)
			if fatal && !utf8.Valid(b) {
				return "", errors.New("TypeError: the encoded data was not valid utf-8")
			}
			return strings.ToValidUTF8(string(b), "�"), nil
		}
		out, err := enc.NewDecoder().Bytes(b)
		if err != nil {
			return "", err
		}
		return string(out), nil
	})
	host.Set("log", func(level, text string) {
		if s.logs == nil || s.logged >= maxLog {
			return
		}
		line := truncate(level+": "+text, 2000) + "\n"
		s.logged += len(line)
		_, _ = io.WriteString(s.logs, line)
	})
}

// decoder is the encoding for a WHATWG label; nil for UTF-8.
func decoder(label string) (encoding.Encoding, error) {
	label = strings.ToLower(strings.TrimSpace(label))
	if label == "" || label == "utf-8" || label == "utf8" || label == "unicode-1-1-utf-8" {
		return nil, nil
	}
	enc, err := htmlindex.Get(label)
	if err != nil {
		return nil, fmt.Errorf("RangeError: the %q encoding is not supported", label)
	}
	if enc == unicode.UTF8 {
		return nil, nil
	}
	return enc, nil
}

func trimBOM(b []byte) []byte {
	if len(b) >= 3 && b[0] == 0xef && b[1] == 0xbb && b[2] == 0xbf {
		return b[3:]
	}
	return b
}

// latin1 is bytes as a JS "binary string": one character per byte.
func latin1(data []byte) string {
	runes := make([]rune, len(data))
	for i, b := range data {
		runes[i] = rune(b)
	}
	return string(runes)
}

// installTimers adds setTimer(fn, ms, args, repeat) and clearTimer(id).
func (s *sandbox) installTimers(host *goja.Object) {
	vm := s.vm
	host.Set("setTimer", func(call goja.FunctionCall) goja.Value {
		fn, ok := goja.AssertFunction(call.Argument(0))
		if !ok {
			panic(vm.NewTypeError("setTimeout needs a function"))
		}
		var args []goja.Value
		if a, ok := call.Argument(2).(*goja.Object); ok {
			_ = vm.ExportTo(a, &args)
		}
		id, err := s.loop.setTimer(fn, call.Argument(1).ToFloat(), args, call.Argument(3).ToBoolean())
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(id)
	})
	host.Set("clearTimer", func(id int64) { s.loop.clearTimer(id) })
}
