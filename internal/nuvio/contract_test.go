package nuvio

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/nuvio/nuviotest"
)

// The contract tests of #33. Nuvio's sync functions are undocumented and may
// change, so every endpoint this package calls is listed in contract with
// the Go type it reads the answer into, and TestContract calls each of them
// the way the client does, checking every answer against that type. A field
// that goes missing, turns null or changes type fails with a message naming
// the endpoint, the field and where Peli reads it.
//
// TestContract runs against nuviotest's fake on every `go test`, and against
// a self-hosted Nuvio when PELI_CONTRACT_URL is set (CI's scheduled
// contract job, ADR-0020). Running the same cases on both keeps the fake
// honest. docs/nuvio-release-checklist.md covers what self-host can't: drift
// between it and api.nuvio.tv.

// answer is what the client reads from an endpoint's 2xx answer.
type answer struct {
	row  reflect.Type // nil: the answer isn't read
	many bool         // an array of rows rather than one object
	// Fields of row the backend leaves out, which the client's doc says
	// not to trust.
	absent []string
}

func rows[T any]() answer { return answer{row: reflect.TypeFor[T](), many: true} }
func one[T any]() answer  { return answer{row: reflect.TypeFor[T]()} }

// avatarImages is where stock avatar images are; AvatarImageURL builds the
// rest of the path.
const avatarImages = "/storage/v1/object/public/avatars/"

// contract lists every endpoint this package calls, by path.
// TestContractCoversEveryCall fails when the client calls one that isn't
// here, and TestContract when a case doesn't reach one that is.
var contract = map[string]answer{
	"/.well-known/nuvio":               one[discovery](),
	"/auth/v1/token":                   one[tokenAnswer](),
	"/auth/v1/logout":                  {},
	"/functions/v1/tv-logins-exchange": one[tokenAnswer](),
	avatarImages:                       {},

	"/rest/v1/rpc/start_device_login_session": rows[deviceLoginRow](),
	"/rest/v1/rpc/poll_tv_login_session":      rows[devicePollRow](),

	"/rest/v1/rpc/sync_pull_profiles":       rows[Profile](),
	"/rest/v1/rpc/sync_pull_profile_locks":  rows[ProfileLock](),
	"/rest/v1/rpc/verify_profile_pin":       rows[VerifyProfilePINResult](),
	"/rest/v1/rpc/set_profile_pin":          {},
	"/rest/v1/rpc/clear_profile_pin":        {},
	"/rest/v1/rpc/sync_patch_profile":       {row: reflect.TypeFor[Profile](), many: true, absent: []string{"pin_enabled", "pin_locked_until"}},
	"/rest/v1/rpc/sync_push_profiles":       {},
	"/rest/v1/rpc/sync_delete_profile_data": {},
	"/rest/v1/rpc/get_avatar_catalog":       rows[Avatar](),

	"/rest/v1/rpc/sync_pull_library_delta":        rows[LibraryEvent](),
	"/rest/v1/rpc/sync_pull_watch_progress_delta": rows[ProgressEvent](),
	"/rest/v1/rpc/sync_pull_watched_items_delta":  rows[WatchedEvent](),
	"/rest/v1/rpc/sync_pull_library":              rows[LibraryRow](),
	"/rest/v1/rpc/sync_pull_watch_progress":       rows[ProgressRow](),
	"/rest/v1/rpc/sync_pull_watched_items":        rows[WatchedRow](),
	"/rest/v1/rpc/sync_push_library_items":        {},
	"/rest/v1/rpc/sync_delete_library_items":      {},
	"/rest/v1/rpc/sync_push_watch_progress":       {},
	"/rest/v1/rpc/sync_delete_watch_progress":     {},
	"/rest/v1/rpc/sync_push_watched_items":        {},
	"/rest/v1/rpc/sync_delete_watched_items":      {},
	"/rest/v1/addons":                             rows[AddonRow](),
	"/rest/v1/rpc/sync_push_addons":               {},
	"/rest/v1/plugins":                            rows[PluginRow](),
	"/rest/v1/rpc/sync_push_plugins":              {},

	"/rest/v1/rpc/sync_pull_home_catalog_settings": rows[HomeLayoutRow](),
	"/rest/v1/rpc/sync_push_home_catalog_settings": {},
	"/rest/v1/rpc/sync_pull_collections":           rows[CollectionsRow](),
	"/rest/v1/rpc/sync_push_collections":           {},
}

// liveOnly lists the endpoints only api.nuvio.tv has: self-host has no watch
// parties (ADR-0051), so TestContract can't reach them, and the fake doesn't
// pretend to. TestLiveParty (live_party_test.go) calls each and checks its
// answer against the type here.
var liveOnly = map[string]answer{
	"/rest/v1/rpc/watch_party_create":        one[PartySnapshot](),
	"/rest/v1/rpc/watch_party_join":          one[PartySnapshot](),
	"/rest/v1/rpc/watch_party_preview":       one[PartyPreview](),
	"/rest/v1/rpc/watch_party_heartbeat":     one[PartySnapshot](),
	"/rest/v1/rpc/watch_party_update":        one[PartySnapshot](),
	"/rest/v1/rpc/watch_party_leave":         one[PartySnapshot](),
	"/rest/v1/rpc/watch_party_end":           one[PartySnapshot](),
	"/rest/v1/rpc/watch_party_set_host_only": one[PartySnapshot](),
	"/rest/v1/rpc/watch_party_remove_member": one[PartySnapshot](),
	"/rest/v1/rpc/watch_party_send_message":  one[PartyMessageSent](),
	"/rest/v1/rpc/watch_party_list_messages": one[PartyMessages](),
	"/rest/v1/rpc/watch_party_clock":         {},
	"/rest/v1/rpc/watch_party_enabled":       {},
}

// shapeErrors checks a JSON answer against the type the client reads it
// into. It returns what doesn't fit, and the fields the client doesn't read,
// which are new or unused, not wrong.
func shapeErrors(data []byte, a answer) (problems, unread []string) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return []string{fmt.Sprintf("the answer isn't JSON: %v", err)}, nil
	}
	list := []any{v}
	if a.many {
		var ok bool
		if list, ok = v.([]any); !ok {
			return []string{fmt.Sprintf("the answer is a JSON %s; Peli reads an array of %s rows", jsonKind(v), a.row.Name())}, nil
		}
	}
	for i, item := range list {
		where := "the answer"
		if a.many {
			where = fmt.Sprintf("row %d", i)
		}
		obj, ok := item.(map[string]any)
		if !ok {
			problems = append(problems, fmt.Sprintf("%s is a JSON %s; Peli reads a %s object", where, jsonKind(item), a.row.Name()))
			continue
		}
		known := map[string]bool{}
		for _, f := range reflect.VisibleFields(a.row) {
			if f.Anonymous || !f.IsExported() {
				continue
			}
			name, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "-" {
				continue
			}
			name = cmp.Or(name, f.Name)
			known[name] = true
			if slices.Contains(a.absent, name) {
				if _, ok := obj[name]; ok {
					problems = append(problems, fmt.Sprintf("%s: field %q is sent now; Peli ignores it in %s.%s, and could read it", where, name, a.row.Name(), f.Name))
				}
				continue
			}
			if p := fieldProblem(obj, name, f.Type, strings.Contains(opts, "omitempty")); p != "" {
				problems = append(problems, fmt.Sprintf("%s: field %q %s (Peli reads it into %s.%s)", where, name, p, a.row.Name(), f.Name))
			}
		}
		for k := range obj {
			if !known[k] && !slices.Contains(unread, k) {
				unread = append(unread, k)
			}
		}
	}
	slices.Sort(unread)
	return problems, unread
}

// fieldProblem says what is wrong with a field of obj that Go reads into
// typ, or "". A pointer or omitempty field may be missing or null; any other
// would silently read as its zero value.
func fieldProblem(obj map[string]any, name string, typ reflect.Type, omitempty bool) string {
	optional := omitempty || typ.Kind() == reflect.Pointer
	v, ok := obj[name]
	switch {
	case !ok && optional, v == nil && ok && (optional || typ.Kind() == reflect.Slice):
		return ""
	case !ok:
		return "is missing"
	case v == nil:
		return "is null"
	}
	if typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	want := goJSONKind(typ)
	if got := jsonKind(v); got != want {
		return fmt.Sprintf("is a JSON %s, not a %s", got, want)
	}
	switch {
	case typ == reflect.TypeFor[time.Time]():
		if _, err := time.Parse(time.RFC3339Nano, v.(string)); err != nil {
			return fmt.Sprintf("is %q, not an RFC 3339 time", v)
		}
	case typ.Kind() >= reflect.Int && typ.Kind() <= reflect.Uint64:
		if f := v.(float64); f != math.Trunc(f) {
			return fmt.Sprintf("is %v, not a whole number", f)
		}
	case typ.Kind() == reflect.Slice:
		for i, e := range v.([]any) {
			if got, want := jsonKind(e), goJSONKind(typ.Elem()); got != want {
				return fmt.Sprintf("has a JSON %s at %d, not a %s", got, i, want)
			}
		}
	}
	return ""
}

// goJSONKind is the JSON kind Go decodes into typ.
func goJSONKind(typ reflect.Type) string {
	switch {
	case typ == reflect.TypeFor[time.Time]() || typ.Kind() == reflect.String:
		return "string"
	case typ.Kind() == reflect.Bool:
		return "bool"
	case typ.Kind() >= reflect.Int && typ.Kind() <= reflect.Float64:
		return "number"
	case typ.Kind() == reflect.Slice:
		return "array"
	}
	return "object"
}

func jsonKind(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "bool"
	case float64:
		return "number"
	case []any:
		return "array"
	}
	return "object"
}

func TestShapeErrors(t *testing.T) {
	type row struct {
		Name    string     `json:"name"`
		Count   int        `json:"count"`
		Tags    []string   `json:"tags,omitempty"`
		Maybe   *string    `json:"maybe"`
		When    time.Time  `json:"when"`
		Updated *time.Time `json:"updated"`
		Skipped string     `json:"-"`
	}
	for _, tc := range []struct {
		name, data string
		many       bool
		want       []string
		unread     []string
	}{
		{name: "fits", many: true, data: `[{"name":"a","count":1,"tags":["x"],"maybe":null,"when":"2026-10-27T10:00:00.123+00:00","updated":null,"new":1}]`, unread: []string{"new"}},
		{name: "optional fields left out", data: `{"name":"a","count":1,"when":"2026-10-27T10:00:00Z"}`},
		{name: "missing", data: `{"count":1,"when":"2026-10-27T10:00:00Z"}`, want: []string{`the answer: field "name" is missing (Peli reads it into row.Name)`}},
		{name: "null", data: `{"name":null,"count":1,"when":"2026-10-27T10:00:00Z"}`, want: []string{`the answer: field "name" is null (Peli reads it into row.Name)`}},
		{name: "type changed", many: true, data: `[{"name":"a","count":"1","when":"2026-10-27T10:00:00Z"}]`, want: []string{`row 0: field "count" is a JSON string, not a number (Peli reads it into row.Count)`}},
		{name: "fraction", data: `{"name":"a","count":1.5,"when":"2026-10-27T10:00:00Z"}`, want: []string{`the answer: field "count" is 1.5, not a whole number (Peli reads it into row.Count)`}},
		{name: "not a time", data: `{"name":"a","count":1,"when":"yesterday"}`, want: []string{`the answer: field "when" is "yesterday", not an RFC 3339 time (Peli reads it into row.When)`}},
		{name: "slice element", data: `{"name":"a","count":1,"when":"2026-10-27T10:00:00Z","tags":[1]}`, want: []string{`the answer: field "tags" has a JSON number at 0, not a string (Peli reads it into row.Tags)`}},
		{name: "object, not rows", many: true, data: `{"name":"a"}`, want: []string{"the answer is a JSON object; Peli reads an array of row rows"}},
		{name: "rows, not an object", data: `[]`, want: []string{"the answer is a JSON array; Peli reads a row object"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			problems, unread := shapeErrors([]byte(tc.data), answer{row: reflect.TypeFor[row](), many: tc.many})
			if !slices.Equal(problems, tc.want) || !slices.Equal(unread, tc.unread) {
				t.Errorf("problems = %q, unread = %q; want %q, %q", problems, unread, tc.want, tc.unread)
			}
		})
	}
}

// TestContractCoversEveryCall reads this package's source for the endpoints
// it calls: a path literal, or an RPC name handed to delta or write. Each
// must be in contract, and nothing may be there that isn't called.
func TestContractCoversEveryCall(t *testing.T) {
	paths := regexp.MustCompile(`^/(\.well-known|auth/v1|rest/v1|functions/v1|storage/v1)/`)
	rpcName := regexp.MustCompile(`^sync_[a-z_]+$`)
	called := map[string]string{}
	files, _ := filepath.Glob("*.go")
	fset := token.NewFileSet()
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			s, _ := strconv.Unquote(lit.Value)
			switch {
			case paths.MatchString(s):
				s, _, _ = strings.Cut(s, "?")
				if s == "/rest/v1/rpc/" {
					return true // delta and write add the name
				}
			case rpcName.MatchString(s):
				s = "/rest/v1/rpc/" + s
			default:
				return true
			}
			called[s] = fset.Position(lit.Pos()).String()
			return true
		})
	}
	for path, where := range called {
		_, ok := contract[path]
		_, live := liveOnly[path]
		if !ok && !live {
			t.Errorf("%s calls %s, which isn't in contract: add it, with the type its answer is read into, and a case to TestContract", where, path)
		}
	}
	for _, listed := range []map[string]answer{contract, liveOnly} {
		for path := range listed {
			if _, ok := called[path]; !ok {
				t.Errorf("contract lists %s, which the client no longer calls", path)
			}
		}
	}
}

// recorder checks every 2xx answer the client gets against contract, and
// counts the endpoints reached.
type recorder struct {
	next http.RoundTripper

	mu       sync.Mutex
	t        *testing.T
	reached  map[string]int
	unread   map[string][]string
	reported map[string]bool
}

func newRecorder(t *testing.T) *recorder {
	return &recorder{next: http.DefaultTransport, t: t, reached: map[string]int{}, unread: map[string][]string{}, reported: map[string]bool{}}
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := r.next.RoundTrip(req)
	if err != nil {
		return res, err
	}
	data, err := io.ReadAll(res.Body)
	res.Body.Close()
	res.Body = io.NopCloser(bytes.NewReader(data))
	if err != nil || res.StatusCode >= 300 {
		return res, err
	}
	path := req.URL.Path
	if strings.HasPrefix(path, avatarImages) {
		path = avatarImages
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := contract[path]
	if !ok {
		r.t.Errorf("nuvio contract: %s %s isn't in contract", req.Method, req.URL.Path)
		return res, nil
	}
	r.reached[path]++
	if a.row == nil {
		return res, nil
	}
	problems, unread := shapeErrors(data, a)
	for _, p := range problems {
		// Once per endpoint and field, not for every row and call.
		_, what, _ := strings.Cut(p, ": ")
		if !r.reported[path+what] {
			r.reported[path+what] = true
			r.t.Errorf("nuvio contract: %s %s: %s", req.Method, path, p)
		}
	}
	for _, k := range unread {
		if !slices.Contains(r.unread[path], k) {
			r.unread[path] = append(r.unread[path], k)
		}
	}
	return res, nil
}

// approve approves a device login as the account s belongs to, as
// nuvio.tv/link does. Peli never approves logins, so this isn't in the
// client.
func approve(t *testing.T, url string, s Session, userCode string) bool {
	t.Helper()
	c := New(url, "0.0.0-contract")
	var rows []struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := c.call(t.Context(), http.MethodPost, "/rest/v1/rpc/approve_device_login_session", s.AccessToken,
		map[string]any{"p_user_code": userCode}, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("approve answered %d rows", len(rows))
	}
	return rows[0].Success
}

// apiCode is the code of an APIError, or "".
func apiCode(err error) string {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Code
	}
	return ""
}

// TestContract calls every endpoint in contract, as the client does, and
// checks the behavior docs/spikes/nuvio-backend.md saw on live: paging and
// cursors, the echo of our own writes, the progress throttle, the 90 %
// watched rule, addon replace-all, device login, and the error table.
func TestContract(t *testing.T) {
	b := nuviotest.NewBackend(t)
	rec := newRecorder(t)
	c := New(b.URL, "0.0.0-contract")
	c.http.Transport = rec
	if b.Fake == nil {
		t.Logf("against %s", b.URL)
	}
	run := func(name string, fn func(t *testing.T)) {
		t.Run(name, func(sub *testing.T) {
			rec.mu.Lock()
			rec.t = sub
			rec.mu.Unlock()
			fn(sub)
			rec.mu.Lock()
			rec.t = t
			rec.mu.Unlock()
		})
	}
	email, password := b.Account(t)
	s, err := c.SignInWithPassword(t.Context(), email, password)
	if err != nil {
		t.Fatal(err)
	}
	const index = 1

	run("auth", func(t *testing.T) {
		if err := c.Ping(t.Context()); err != nil {
			t.Fatal(err)
		}
		if _, err := c.SignInWithPassword(t.Context(), email, "not the password"); !errors.Is(err, ErrInvalidCredentials) {
			t.Errorf("wrong password: err = %v, want ErrInvalidCredentials", err)
		}
		if s.UserID == "" || time.Until(s.ExpiresAt) <= 0 {
			t.Errorf("session has user %q and expires at %v", s.UserID, s.ExpiresAt)
		}
		refreshed, err := c.Refresh(t.Context(), s.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		// The access token can come back the same within a second: GoTrue's
		// claims are in whole seconds.
		if refreshed.RefreshToken == s.RefreshToken || refreshed.UserID != s.UserID {
			t.Error("refresh didn't rotate the refresh token for the same account")
		}
		s = refreshed
	})

	run("profiles", func(t *testing.T) {
		profiles, err := c.Profiles(t.Context(), s)
		if err != nil {
			t.Fatal(err)
		}
		if len(profiles) != 1 || profiles[0].Index != index {
			t.Fatalf("a new account has profiles %+v, want just %d", profiles, index)
		}
		added := Profile{Index: 2, Name: "Second", AvatarColor: "#F5A623"}
		if err := c.PushProfiles(t.Context(), s, append(profiles, added)); err != nil {
			t.Fatal(err)
		}
		name := "Renamed"
		got, err := c.PatchProfile(t.Context(), s, added.Index, ProfilePatch{Name: &name})
		if err != nil || got.Index != added.Index || got.Name != name {
			t.Fatalf("patch = %+v, %v", got, err)
		}
		if err := c.SetProfilePIN(t.Context(), s, added.Index, "1234", ""); err != nil {
			t.Fatal(err)
		}
		locks, err := c.ProfileLocks(t.Context(), s)
		if err != nil || !slices.ContainsFunc(locks, func(l ProfileLock) bool { return l.Index == added.Index && l.PinEnabled }) {
			t.Fatalf("locks after setting a PIN = %+v, %v", locks, err)
		}
		if r, err := c.VerifyProfilePIN(t.Context(), s, added.Index, "0000"); err != nil || r.Unlocked {
			t.Errorf("wrong PIN = %+v, %v", r, err)
		}
		if r, err := c.VerifyProfilePIN(t.Context(), s, added.Index, "1234"); err != nil || !r.Unlocked {
			t.Errorf("right PIN = %+v, %v", r, err)
		}
		if err := c.ClearProfilePIN(t.Context(), s, added.Index, "1234"); err != nil {
			t.Fatal(err)
		}
		if err := c.DeleteProfile(t.Context(), s, added.Index); err != nil {
			t.Fatal(err)
		}
		if profiles, err = c.Profiles(t.Context(), s); err != nil || len(profiles) != 1 {
			t.Fatalf("after the delete: %+v, %v", profiles, err)
		}
	})

	run("avatars", func(t *testing.T) {
		avatars, err := c.AvatarCatalog(t.Context())
		if err != nil || len(avatars) == 0 {
			t.Fatalf("catalog = %d avatars, %v", len(avatars), err)
		}
		res, err := c.http.Get(c.AvatarImageURL(avatars[0]))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "image/") {
			t.Errorf("avatar image: HTTP %d, %s", res.StatusCode, res.Header.Get("Content-Type"))
		}
	})

	run("library paging and cursor", func(t *testing.T) {
		items := make([]LibraryRow, DeltaLimit+1)
		for i := range items {
			items[i] = LibraryRow{ContentID: fmt.Sprintf("tt9%06d", i), ContentType: "movie", Name: fmt.Sprintf("Film %d", i), AddedAt: int64(1_700_000_000_000 + i)}
		}
		if err := c.PushLibrary(t.Context(), s, index, items); err != nil {
			t.Fatal(err)
		}
		// Our own writes come back: a full pull from 0 pages through them.
		first, err := c.LibraryDelta(t.Context(), s, index, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(first) != DeltaLimit {
			t.Fatalf("first page has %d events, want %d", len(first), DeltaLimit)
		}
		cursor := first[len(first)-1].EventID
		rest, err := c.LibraryDelta(t.Context(), s, index, cursor)
		if err != nil || len(rest) != 1 {
			t.Fatalf("second page = %d events, %v; want 1", len(rest), err)
		}
		all := append(first, rest...)
		for i, e := range all {
			if e.Operation != OpUpsert || (i > 0 && e.EventID <= all[i-1].EventID) {
				t.Fatalf("event %d is %s %d after %d: want upserts, oldest first", i, e.Operation, e.EventID, all[i-1].EventID)
			}
		}
		if got := all[len(all)-1]; got.ContentID != items[len(items)-1].ContentID {
			t.Errorf("last event is %s, want the last item pushed", got.ContentID)
		}
		// The cursor is the last event's ID: nothing after it.
		cursor = rest[0].EventID
		if none, err := c.LibraryDelta(t.Context(), s, index, cursor); err != nil || len(none) != 0 {
			t.Fatalf("delta after the last event = %d events, %v", len(none), err)
		}
		// A delete comes as an event carrying the row.
		if err := c.DeleteLibrary(t.Context(), s, index, []LibraryKey{{ContentID: items[0].ContentID, ContentType: "movie"}}); err != nil {
			t.Fatal(err)
		}
		deleted, err := c.LibraryDelta(t.Context(), s, index, cursor)
		if err != nil || len(deleted) != 1 || deleted[0].Operation != OpDelete || deleted[0].ContentID != items[0].ContentID {
			t.Fatalf("delta after a delete = %+v, %v", deleted, err)
		}
	})

	run("snapshots", func(t *testing.T) {
		// The library paging case above left DeltaLimit items, less the one
		// it deleted: more than a page of them.
		library, err := c.LibraryList(t.Context(), s, index)
		if err != nil {
			t.Fatal(err)
		}
		if len(library) != DeltaLimit {
			t.Fatalf("library snapshot has %d items, want %d", len(library), DeltaLimit)
		}
		seen := map[string]bool{}
		for _, item := range library {
			if seen[item.ContentID] {
				t.Fatalf("library snapshot repeats %s across pages", item.ContentID)
			}
			seen[item.ContentID] = true
		}
		if _, complete, err := c.ProgressList(t.Context(), s, index); err != nil || !complete {
			t.Fatalf("progress snapshot: complete %v, %v", complete, err)
		}
		if _, err := c.WatchedList(t.Context(), s, index); err != nil {
			t.Fatal(err)
		}
	})

	run("progress throttle and key", func(t *testing.T) {
		start, err := c.ProgressDelta(t.Context(), s, index, 0)
		if err != nil {
			t.Fatal(err)
		}
		var cursor int64
		if len(start) > 0 {
			cursor = start[len(start)-1].EventID
		}
		const lastWatched = 1_800_000_000_000
		ep := ProgressRow{ContentID: "tt0903747", ContentType: "series", VideoID: "tt0903747:1:2",
			Season: ptr(1), Episode: ptr(2), Duration: 3_000_000}
		// stored pushes one entry and reports whether it came back in the feed.
		stored := func(position, lastWatched int64) bool {
			t.Helper()
			e := ep
			e.Position, e.LastWatched = position, lastWatched
			if err := c.PushProgress(t.Context(), s, index, []ProgressRow{e}); err != nil {
				t.Fatal(err)
			}
			events, err := c.ProgressDelta(t.Context(), s, index, cursor)
			if err != nil {
				t.Fatal(err)
			}
			if len(events) == 0 {
				return false
			}
			cursor = events[len(events)-1].EventID
			if got := events[len(events)-1]; got.Position != position || got.ProgressKey == "" || got.Operation != OpUpsert {
				t.Fatalf("stored %+v, want position %d with a progress key", got, position)
			}
			return true
		}
		if !stored(600_000, lastWatched) {
			t.Fatal("the first push wasn't stored")
		}
		// Gotcha 1: dropped unless it moved 15 s or is 30 s newer.
		if stored(610_000, lastWatched+1_000) {
			t.Error("a push 10 s on and 1 s newer was stored; the throttle is gone or changed")
		}
		if !stored(616_000, lastWatched+2_000) {
			t.Error("a push 16 s on wasn't stored")
		}
		if !stored(616_000, lastWatched+40_000) {
			t.Error("a push 40 s newer at the same position wasn't stored")
		}
		events, err := c.ProgressDelta(t.Context(), s, index, 0)
		if err != nil || len(events) == 0 {
			t.Fatalf("full pull = %d events, %v", len(events), err)
		}
		key := events[len(events)-1].ProgressKey
		if err := c.DeleteProgress(t.Context(), s, index, []string{key}); err != nil {
			t.Fatal(err)
		}
		deleted, err := c.ProgressDelta(t.Context(), s, index, cursor)
		if err != nil || len(deleted) != 1 || deleted[0].Operation != OpDelete || deleted[0].ProgressKey != key {
			t.Fatalf("delta after deleting %q = %+v, %v", key, deleted, err)
		}
	})

	run("90 % watched", func(t *testing.T) {
		start, err := c.WatchedDelta(t.Context(), s, index, 0)
		if err != nil {
			t.Fatal(err)
		}
		var cursor int64
		if len(start) > 0 {
			cursor = start[len(start)-1].EventID
		}
		film := ProgressRow{ContentID: "tt0111161", ContentType: "movie", VideoID: "tt0111161",
			Position: 8_100_000, Duration: 8_520_000, LastWatched: 1_800_000_100_000}
		if err := c.PushProgress(t.Context(), s, index, []ProgressRow{film}); err != nil {
			t.Fatal(err)
		}
		events, err := c.WatchedDelta(t.Context(), s, index, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.ContainsFunc(events, func(e WatchedEvent) bool { return e.ContentID == film.ContentID && e.Operation == OpUpsert }) {
			t.Errorf("progress at 95 %% added no watched item: %+v", events)
		}
	})

	run("watched", func(t *testing.T) {
		start, err := c.WatchedDelta(t.Context(), s, index, 0)
		if err != nil {
			t.Fatal(err)
		}
		var cursor int64
		if len(start) > 0 {
			cursor = start[len(start)-1].EventID
		}
		item := WatchedRow{ContentID: "tt0903747", ContentType: "series", Title: "Breaking Bad", Season: ptr(1), Episode: ptr(1), WatchedAt: 1_800_000_200_000}
		if err := c.PushWatched(t.Context(), s, index, []WatchedRow{item}); err != nil {
			t.Fatal(err)
		}
		events, err := c.WatchedDelta(t.Context(), s, index, cursor)
		if err != nil || len(events) != 1 || events[0].Operation != OpUpsert || events[0].ContentID != item.ContentID {
			t.Fatalf("delta after a push = %+v, %v", events, err)
		}
		cursor = events[0].EventID
		if err := c.DeleteWatched(t.Context(), s, index, []WatchedKey{{ContentID: item.ContentID, Season: item.Season, Episode: item.Episode}}); err != nil {
			t.Fatal(err)
		}
		events, err = c.WatchedDelta(t.Context(), s, index, cursor)
		if err != nil || len(events) != 1 || events[0].Operation != OpDelete {
			t.Fatalf("delta after a delete = %+v, %v", events, err)
		}
	})

	run("addons replace-all", func(t *testing.T) {
		a := AddonRow{URL: "https://a.example.com/manifest.json", Name: "A", Enabled: true}
		b := AddonRow{URL: "https://b.example.com/manifest.json", Name: "B", Enabled: false}
		if err := c.PushAddons(t.Context(), s, index, []AddonRow{a, b}); err != nil {
			t.Fatal(err)
		}
		got, err := c.Addons(t.Context(), s, index)
		b.SortOrder = 1
		if err != nil || !slices.Equal(got, []AddonRow{a, b}) {
			t.Fatalf("addons = %+v, %v; want %+v", got, err, []AddonRow{a, b})
		}
		if err := c.PushAddons(t.Context(), s, index, []AddonRow{b}); err != nil {
			t.Fatal(err)
		}
		got, err = c.Addons(t.Context(), s, index)
		b.SortOrder = 0
		if err != nil || !slices.Equal(got, []AddonRow{b}) {
			t.Fatalf("after pushing one addon: %+v, %v; want only %+v", got, err, b)
		}
	})

	run("plugin repositories replace-all", func(t *testing.T) {
		js, dex := "NUVIO_JS", "EXTERNAL_DEX"
		a := PluginRow{URL: "https://a.example.com/manifest.json", Name: ptr("A"), Enabled: true, RepoType: &js}
		b := PluginRow{URL: "https://b.example.com/repo.cs3", Name: ptr("B"), Enabled: false, RepoType: &dex}
		if err := c.PushPlugins(t.Context(), s, index, []PluginRow{a, b}); err != nil {
			t.Fatal(err)
		}
		got, err := c.Plugins(t.Context(), s, index)
		b.SortOrder = 1
		if err != nil || !reflect.DeepEqual(got, []PluginRow{a, b}) {
			t.Fatalf("plugins = %+v, %v; want %+v", got, err, []PluginRow{a, b})
		}
		// A repository pushed without a type (Nuvio's desktop app) has none.
		a.RepoType = nil
		if err := c.PushPlugins(t.Context(), s, index, []PluginRow{a}); err != nil {
			t.Fatal(err)
		}
		got, err = c.Plugins(t.Context(), s, index)
		if err != nil || !reflect.DeepEqual(got, []PluginRow{a}) {
			t.Fatalf("after pushing one repository: %+v, %v; want only %+v", got, err, a)
		}
	})

	// Pushed only to a custom server (#35): a second client that takes the
	// backend for one.
	run("home layout and collections", func(t *testing.T) {
		own := New("https://nuvio.invalid", "0.0.0-contract")
		own.http.Transport = rec
		own.UseServer(c.ServerURL(), "")
		if got, err := own.HomeLayout(t.Context(), s, index); err != nil || got != nil {
			t.Fatalf("a new account's layout = %v, %v", got, err)
		}
		settings := json.RawMessage(`{"items":[{"key":"org.cinemeta:movie:top","addon_id":"org.cinemeta","type":"movie","catalog_id":"top","enabled":true,"order":0,"custom_title":"","is_collection":false,"collection_id":""}],"hide_unreleased_content":false}`)
		if err := own.PushHomeLayout(t.Context(), s, index, settings); err != nil {
			t.Fatal(err)
		}
		got, err := own.HomeLayout(t.Context(), s, index)
		if err != nil || string(got["items"]) == "" || string(got["hide_unreleased_content"]) != "false" {
			t.Fatalf("layout after a push = %v, %v", got, err)
		}
		if err := own.PushCollections(t.Context(), s, index, json.RawMessage(`[{"id":"c1","title":"Streaming","folders":[]}]`)); err != nil {
			t.Fatal(err)
		}
		collections, err := own.Collections(t.Context(), s, index)
		if err != nil || len(collections) != 1 || collections[0]["title"] != "Streaming" {
			t.Fatalf("collections after a push = %v, %v", collections, err)
		}
		if err := c.PushCollections(t.Context(), s, index, json.RawMessage(`[]`)); !errors.Is(err, ErrNuviosServer) {
			t.Errorf("push from the client made for this backend: err = %v, want ErrNuviosServer", err)
		}
	})

	run("device login", func(t *testing.T) {
		// Another account, signed in on a phone, approves.
		otherEmail, otherPassword := b.Account(t)
		phone, err := c.SignInWithPassword(t.Context(), otherEmail, otherPassword)
		if err != nil {
			t.Fatal(err)
		}
		login, err := c.StartDeviceLogin(t.Context(), DefaultLinkURL, "Peli contract test")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(login.URL, DefaultLinkURL+"?code=") || login.UserCode == "" || time.Until(login.ExpiresAt) <= 0 {
			t.Errorf("login: URL %q, user code of %d characters, expires in %v", login.URL, len(login.UserCode), time.Until(login.ExpiresAt))
		}
		if status, _, err := c.PollDeviceLogin(t.Context(), login); err != nil || status != DeviceLoginPending {
			t.Fatalf("poll before approval = %q, %v", status, err)
		}
		if !approve(t, b.URL, phone, login.UserCode) {
			t.Fatal("the phone couldn't approve the login")
		}
		if status, _, err := c.PollDeviceLogin(t.Context(), login); err != nil || status != DeviceLoginApproved {
			t.Fatalf("poll after approval = %q, %v", status, err)
		}
		got, err := c.ExchangeDeviceLogin(t.Context(), login)
		if err != nil {
			t.Fatal(err)
		}
		if got.UserID != phone.UserID {
			t.Error("the exchanged session isn't the approving account's")
		}
		if _, err := c.ExchangeDeviceLogin(t.Context(), login); !errors.Is(err, ErrDeviceLoginExpired) {
			t.Errorf("second exchange: err = %v, want ErrDeviceLoginExpired", err)
		}
	})

	// docs/spikes/nuvio-backend.md, "Errors a client has to handle". The 429
	// row is left to TestRateLimitBacksOffThenSucceeds: flooding a backend
	// to reach it would slow every run.
	run("errors", func(t *testing.T) {
		if _, err := c.LibraryDelta(t.Context(), s, index, 0); err != nil {
			t.Fatal(err)
		}
		if _, err := c.LibraryDelta(t.Context(), Session{}, index, 0); !errors.Is(err, ErrSignedOut) {
			t.Errorf("sync call with no session: err = %v, want ErrSignedOut", err)
		}
		head, _, _ := strings.Cut(s.AccessToken, ".")
		forged := Session{AccessToken: head + ".eyJzdWIiOiJ4In0.Zm9yZ2Vk"}
		if _, err := c.LibraryDelta(t.Context(), forged, index, 0); !errors.Is(err, ErrSignedOut) {
			t.Errorf("forged token: err = %v, want ErrSignedOut", err)
		}
		err = c.call(t.Context(), http.MethodPost, "/rest/v1/rpc/sync_pull_library_delta", s.AccessToken,
			map[string]any{"p_profile_id": index, "p_since": 0, "p_limit": 1}, nil)
		if apiCode(err) != "PGRST202" {
			t.Errorf("wrong argument name: err = %v, want PGRST202", err)
		}
		err = c.call(t.Context(), http.MethodPost, "/rest/v1/rpc/sync_pull_library_delta", s.AccessToken,
			map[string]any{"p_profile_id": "one", "p_since_event_id": 0, "p_limit": 1}, nil)
		if apiCode(err) != "22P02" {
			t.Errorf("wrong argument type: err = %v, want 22P02", err)
		}
		// Writes check the index; pulls just find no rows.
		if err := c.PushLibrary(t.Context(), s, MaxProfiles+1, []LibraryRow{}); apiCode(err) != "P0001" {
			t.Errorf("push to profile index %d: err = %v, want P0001", MaxProfiles+1, err)
		}
		if events, err := c.LibraryDelta(t.Context(), s, MaxProfiles+1, 0); err != nil || len(events) != 0 {
			t.Errorf("pull from profile index %d = %d events, %v; want none", MaxProfiles+1, len(events), err)
		}
		if _, _, err := c.PollDeviceLogin(t.Context(), DeviceLogin{deviceCode: "no-such-code", nonce: strings.Repeat("0", 48)}); !errors.Is(err, ErrDeviceLoginExpired) {
			t.Errorf("poll an unknown code: err = %v, want ErrDeviceLoginExpired", err)
		}
		if approve(t, b.URL, s, "NOSUCH") {
			t.Error("approving an unknown code succeeded")
		}
	})

	run("sign out", func(t *testing.T) {
		if err := c.SignOut(t.Context(), s); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Refresh(t.Context(), s.RefreshToken); !errors.Is(err, ErrSignedOut) {
			t.Errorf("refresh after sign-out: err = %v, want ErrSignedOut", err)
		}
	})

	rec.mu.Lock()
	defer rec.mu.Unlock()
	for path := range contract {
		if rec.reached[path] == 0 {
			t.Errorf("nuvio contract: no case got an answer from %s; add one to TestContract", path)
		}
	}
	if b.Fake == nil {
		for path, fields := range rec.unread {
			slices.Sort(fields)
			t.Logf("%s also sends %s", path, strings.Join(fields, ", "))
		}
	}
	if os.Getenv(nuviotest.ContractURL) != "" && t.Failed() {
		t.Log("A failure here means the backend changed shape or behavior. Check docs/nuvio-release-checklist.md.")
	}
}
