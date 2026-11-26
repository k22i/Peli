// Spike: is Nuvio's synced account data a viable place to announce a running
// watch party, so another profile of the same account can find the code?
//
// Explore mode is read-only: it lists what PostgREST exposes (tables and
// functions), the columns of every table it may read, and the parameters of
// every function, so the writable surface is known before anything is written.
//
//	go run ./spikes/party-account-sync explore
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"context"

	"github.com/k22i/Peli/internal/nuvio"
)

const userAgent = "Peli/0.0.0-party-account-sync-spike (+https://github.com/k22i/Peli)"

func main() {
	mode := "explore"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	var err error
	switch mode {
	case "explore":
		err = explore()
	case "raw":
		err = rawPath(os.Args[2])
	case "get":
		err = getPath(os.Args[2])
	case "rpc":
		err = rpcPath(os.Args[2], os.Args[3])
	case "run":
		err = roundTrip()
	case "run2":
		err = crossProfile()
	case "timing":
		err = timing()
	case "run3":
		err = twoProfiles()
	default:
		err = fmt.Errorf("unknown mode %q", mode)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "spike failed: %v\n", err)
		os.Exit(1)
	}
}

func explore() error {
	email, password := os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD")
	if email == "" || password == "" {
		return fmt.Errorf("set NUVIO_EMAIL and NUVIO_PASSWORD (set -a; source spikes/nuvio-backend/.env)")
	}
	base := strings.TrimRight(os.Getenv("NUVIO_URL"), "/")
	if base == "" {
		base = nuvio.DefaultURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	red := &redactor{}
	red.add(email, "<email>")
	red.add(password, "<password>")
	logf := red.printf

	key, err := discoveryKey(ctx, base)
	if err != nil {
		return err
	}
	red.add(key, "<apikey>")

	c := nuvio.New(base, "0.0.0-party-account-sync-spike")
	s, err := c.SignInWithPassword(ctx, email, password)
	if err != nil {
		return err
	}
	red.add(s.AccessToken, "<access-token>")
	red.add(s.RefreshToken, "<refresh-token>")
	red.add(s.UserID, "<user-uuid>")
	defer func() {
		if err := c.SignOut(context.Background(), s); err != nil {
			fmt.Fprintf(os.Stderr, "sign out: %v\n", err)
			return
		}
		fmt.Print("signed out\n")
	}()
	api := &client{base: base, key: key, red: red, http: &http.Client{Timeout: 20 * time.Second}, token: s.AccessToken}

	logf("== backend\n%s, account %s\n\n", base, s.UserID)

	// Every path PostgREST offers this session, split into tables and functions.
	res, err := api.get(ctx, "/rest/v1/")
	if err != nil {
		return fmt.Errorf("openapi: %w", err)
	}
	var doc struct {
		Paths      map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(res, &doc); err != nil {
		return fmt.Errorf("openapi: %w", err)
	}
	paths := make([]string, 0, len(doc.Paths))
	for p := range doc.Paths {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	logf("== %d paths\n", len(paths))
	for _, p := range paths {
		logf("  %s\n", p)
	}
	logf("\n")

	// Functions: their parameters, from the request body schema.
	logf("== function parameters\n")
	for _, p := range paths {
		if !strings.HasPrefix(p, "/rpc/") {
			continue
		}
		params := functionParams(doc.Paths[p], doc.Components.Schemas)
		logf("  %-46s %s\n", strings.TrimPrefix(p, "/rpc/"), strings.Join(params, ", "))
	}
	logf("\n")

	// Tables: the columns of one row each (values are not printed).
	logf("== table columns (keys only, no values)\n")
	for _, p := range paths {
		if strings.HasPrefix(p, "/rpc/") {
			continue
		}
		cols, err := api.columns(ctx, "/rest/v1"+p+"?limit=1")
		if err != nil {
			logf("  %-30s %v\n", p, err)
			continue
		}
		logf("  %-30s %s\n", p, strings.Join(cols, ", "))
	}
	logf("\n")

	// The profiles, straight from the sync RPC the account uses: how many are
	// there, and are their names/avatars the only free text?
	profiles, err := c.Profiles(ctx, s)
	if err != nil {
		logf("== profiles: %v\n", err)
	} else {
		logf("== %d profiles\n", len(profiles))
		for _, p := range profiles {
			logf("  index %d, name %q, avatar id set: %v, uses primary addons: %v\n", p.Index, p.Name, p.AvatarID != nil, p.UsesPrimaryAddons)
		}
	}
	logf("\n")
	return nil
}

// functionParams reads a function's request body schema into "name:type, …".
func functionParams(path json.RawMessage, schemas map[string]json.RawMessage) []string {
	var item struct {
		Post struct {
			RequestBody struct {
				Content map[string]struct {
					Schema json.RawMessage `json:"schema"`
				} `json:"content"`
			} `json:"requestBody"`
		} `json:"post"`
	}
	if json.Unmarshal(path, &item) != nil {
		return nil
	}
	var params []string
	for _, media := range item.Post.RequestBody.Content {
		var schema struct {
			Properties map[string]struct {
				Type   string          `json:"type"`
				Format string          `json:"format"`
				Ref    string          `json:"$ref"`
				AnyOf  []any           `json:"anyOf"`
				Items  json.RawMessage `json:"items"`
			} `json:"properties"`
			Required []string `json:"required"`
		}
		if json.Unmarshal(media.Schema, &schema) != nil {
			continue
		}
		names := make([]string, 0, len(schema.Properties))
		for name := range schema.Properties {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			prop := schema.Properties[name]
			kind := prop.Type
			if kind == "" && prop.Ref != "" {
				kind = strings.TrimPrefix(prop.Ref, "#/components/schemas/")
			}
			if kind == "" && len(prop.AnyOf) > 0 {
				kind = "anyOf"
			}
			params = append(params, name+":"+kind)
		}
	}
	return params
}

// --- plumbing --------------------------------------------------------------

type client struct {
	base  string
	key   string
	token string
	http  *http.Client
	red   *redactor
}

// get reads a path from the backend with the session, returning the body.
func (a *client) get(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Apikey", a.key)
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	res, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode >= 300 {
		return data, fmt.Errorf("HTTP %d %s", res.StatusCode, oneLine(string(data), 160))
	}
	return data, err
}

// columns returns the JSON keys of the first row of a table query.
func (a *client) columns(ctx context.Context, query string) ([]string, error) {
	data, err := a.get(ctx, query)
	if err != nil {
		return nil, err
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, fmt.Errorf("not a row set")
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("no rows to read columns from")
	}
	cols := make([]string, 0, len(rows[0]))
	for col := range rows[0] {
		cols = append(cols, col)
	}
	sort.Strings(cols)
	return cols, nil
}

// post sends a JSON body to a path with the session.
func (a *client) post(ctx context.Context, path string, body any) (int, []byte, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+path, bytes.NewReader(data))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Apikey", a.key)
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	res, err := a.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	return res.StatusCode, answer, nil
}

func discoveryKey(ctx context.Context, base string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/.well-known/nuvio", nil)
	req.Header.Set("User-Agent", userAgent)
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var doc struct {
		Service        string `json:"service"`
		PublishableKey string `json:"publishable_key"`
	}
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		return "", err
	}
	if doc.Service != "nuvio" || doc.PublishableKey == "" {
		return "", fmt.Errorf("not a Nuvio backend: %q", doc.Service)
	}
	return doc.PublishableKey, nil
}

type redactor struct{ pairs [][2]string }

func (r *redactor) add(secret, name string) {
	if secret == "" || secret == name {
		return
	}
	r.pairs = append(r.pairs, [2]string{secret, name})
	sort.SliceStable(r.pairs, func(i, j int) bool { return len(r.pairs[i][0]) > len(r.pairs[j][0]) })
}

var (
	jwtish  = regexp.MustCompile(`eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}`)
	uuidish = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
)

func (r *redactor) apply(s string) string {
	for _, p := range r.pairs {
		s = strings.ReplaceAll(s, p[0], p[1])
	}
	s = jwtish.ReplaceAllString(s, "<token>")
	s = uuidish.ReplaceAllString(s, "<uuid>")
	return s
}

func (r *redactor) printf(format string, a ...any) {
	fmt.Print(r.apply(fmt.Sprintf(format, a...)))
}

func oneLine(s string, max int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}

func randomHex(n int) string {
	const hexdigits = "0123456789abcdef"
	b := make([]byte, n)
	rand.Read(b)
	for i := range b {
		b[i] = hexdigits[int(b[i])%16]
	}
	return string(b)
}

// roundTrip is the viability test: can one session of an account leave a
// party announcement in synced account data that another session reads back,
// and can the row be removed afterwards?
func roundTrip() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	a, doneA, err := openSession(ctx)
	if err != nil {
		return err
	}
	defer doneA()
	b, doneB, err := openSession(ctx)
	if err != nil {
		return err
	}
	defer doneB()
	a.red.add(b.token, "<access-token-b>")
	logf := a.red.printf

	const platform = "peli-spike"
	const profile = 1
	announcement := map[string]any{
		"v": 1,
		"party": map[string]any{
			"id":   "11111111-2222-4333-8444-555555555555",
			"code": "TEST01", "host": "Peli spike",
			"media": map[string]any{"type": "movie", "meta_id": "tt0000001", "title": "Peli spike"},
			"at":    1764200000000,
		},
	}

	logf("== 1. baseline: which (profile, platform) rows the account has, and when\n")
	before, err := a.rows(ctx, profile)
	if err != nil {
		return err
	}
	logf("%s\n\n", a.red.apply(before))

	logf("== 2. can this session delete a row at all? (a no-match delete, removes nothing)\n")
	status, body, err := a.delete(ctx, "?profile_id=eq."+itoa(profile)+"&platform=eq."+platform)
	logf("  DELETE /rest/v1/profile_settings_blobs?platform=eq.%s -> HTTP %d %s, %v\n\n",
		platform, status, oneLine(string(body), 120), err)
	if status < 200 || status > 299 {
		logf("  no delete permission: the write test would leave a row behind, so stopping here\n")
		return nil
	}

	logf("== 3. A writes the announcement, platform %q, profile %d\n", platform, profile)
	start := time.Now()
	status, body, err = a.post(ctx, "/rest/v1/rpc/sync_push_profile_settings_blob", map[string]any{
		"p_profile_id": profile, "p_platform": platform, "p_settings_json": announcement,
		"p_origin_client_id": "peli-spike-" + randomHex(4),
	})
	logf("  sync_push_profile_settings_blob -> HTTP %d %s (%v), %v\n\n",
		status, oneLine(string(body), 160), time.Since(start).Round(time.Millisecond), err)

	logf("== 4. B (a second session of the same account) reads it back\n")
	start = time.Now()
	read, err := b.pull(ctx, profile, platform)
	elapsed := time.Since(start)
	logf("  sync_pull_profile_settings_blob(p_profile_id=%d, p_platform=%q) -> %s (%v), %v\n",
		profile, platform, oneLine(read, 400), elapsed.Round(time.Millisecond), err)
	logf("  same as what A wrote: %v\n\n", strings.Contains(read, "\"TEST01\""))

	logf("== 5. the same read with no p_platform, which is one call for a Join page\n")
	all, err := b.pull(ctx, profile, "")
	logf("  answers %d bytes, mentions %q: %v, %v\n\n", len(all), platform, strings.Contains(all, platform), err)

	logf("== 6. other platforms are untouched\n")
	after, err := a.rows(ctx, profile)
	if err != nil {
		return err
	}
	logf("%s\n", a.red.apply(after))
	logf("  desktop and tv rows unchanged: %v\n\n", strings.Replace(before, " ", "", -1) == strings.Replace(afterRow(after, platform), " ", "", -1))

	logf("== 7. compare-and-set: the guarded push refuses a stale updated_at\n")
	var rowsParsed []map[string]any
	json.Unmarshal([]byte(after), &rowsParsed)
	updated := ""
	for _, row := range rowsParsed {
		if row["platform"] == platform {
			updated, _ = row["updated_at"].(string)
		}
	}
	logf("  the row's updated_at is %q\n", updated)
	status, body, err = a.post(ctx, "/rest/v1/rpc/sync_push_profile_settings_blob_guarded", map[string]any{
		"p_profile_id": profile, "p_platform": platform,
		"p_settings_json":       map[string]any{"v": 1, "party": nil},
		"p_expected_updated_at": "2000-01-01T00:00:00+00:00",
	})
	logf("  with a wrong updated_at -> HTTP %d %s, %v\n", status, oneLine(string(body), 200), err)
	status, body, err = a.post(ctx, "/rest/v1/rpc/sync_push_profile_settings_blob_guarded", map[string]any{
		"p_profile_id": profile, "p_platform": platform,
		"p_settings_json":       announcement,
		"p_expected_updated_at": updated,
	})
	logf("  with the row's own updated_at -> HTTP %d %s, %v\n\n", status, oneLine(string(body), 200), err)

	logf("== 8. a bigger blob (32 KiB) round-trips?\n")
	big := map[string]any{"v": 1, "party": map[string]any{"code": "TEST01", "padding": strings.Repeat("x", 32<<10)}}
	status, body, err = a.post(ctx, "/rest/v1/rpc/sync_push_profile_settings_blob", map[string]any{
		"p_profile_id": profile, "p_platform": platform, "p_settings_json": big,
		"p_origin_client_id": "peli-spike-" + randomHex(4),
	})
	logf("  write -> HTTP %d %s, %v\n", status, oneLine(string(body), 120), err)
	read, err = b.pull(ctx, profile, platform)
	logf("  B reads back %d bytes, complete: %v, %v\n\n", len(read), strings.Contains(read, strings.Repeat("x", 1000)), err)

	logf("== 9. another profile index on this account\n")
	logf("  B pull profile 2, platform %q: %s\n", platform, oneLine(must(b.pull(ctx, 2, platform)), 200))
	logf("  B pull profile 2, every platform: %s\n", oneLine(must(b.pull(ctx, 2, "")), 200))
	logf("  B reads the table for profile 2: %s\n\n", oneLine(mustRows(b.rows(ctx, 2)), 200))

	logf("== 10. undo: delete the row and check the account is back as it was\n")
	status, body, err = a.delete(ctx, "?profile_id=eq."+itoa(profile)+"&platform=eq."+platform)
	logf("  DELETE -> HTTP %d %s, %v\n", status, oneLine(string(body), 120), err)
	final, err := a.rows(ctx, profile)
	if err != nil {
		return err
	}
	logf("%s\n", a.red.apply(final))
	logf("  back to the baseline: %v\n", strings.Replace(before, " ", "", -1) == strings.Replace(final, " ", "", -1))
	logf("  B pull of %q now: %s\n", platform, oneLine(must(b.pull(ctx, profile, platform)), 200))
	return nil
}

// crossProfile tests the shape a Join page would actually use: one table read
// that lists the platform's rows for the whole account, and whether a session
// may write another profile index's row. Undone with a delete.
func crossProfile() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	a, doneA, err := openSession(ctx)
	if err != nil {
		return err
	}
	defer doneA()
	b, doneB, err := openSession(ctx)
	if err != nil {
		return err
	}
	defer doneB()
	logf := a.red.printf

	const platform = "peli-spike"
	announcement := map[string]any{"v": 1, "party": map[string]any{
		"id": "11111111-2222-4333-8444-555555555555", "code": "TEST01", "host": "Peli spike",
		"media": map[string]any{"type": "movie", "meta_id": "tt0000001", "title": "Peli spike"},
		"at":    1764200000000,
	}}

	tuple := func(rows string) string {
		var parsed []map[string]any
		json.Unmarshal([]byte(rows), &parsed)
		out := make([]string, 0, len(parsed))
		for _, row := range parsed {
			if row["platform"] == platform {
				continue
			}
			out = append(out, fmt.Sprint(row["profile_id"], "/", row["platform"], "/", row["updated_at"]))
		}
		sort.Strings(out)
		return strings.Join(out, "; ")
	}

	logf("== 1. the account's settings rows before (profile/platform/updated_at)\n")
	p1, _ := a.rows(ctx, 1)
	p2, _ := a.rows(ctx, 2)
	logf("  profile 1: %s\n  profile 2: %s\n", a.red.apply(tuple(p1)), a.red.apply(tuple(p2)))
	before := tuple(p1) + " | " + tuple(p2)

	logf("\n== 2. A writes the announcement to profile 1, platform %q\n", platform)
	status, body, err := a.post(ctx, "/rest/v1/rpc/sync_push_profile_settings_blob", map[string]any{
		"p_profile_id": 1, "p_platform": platform, "p_settings_json": announcement,
		"p_origin_client_id": "peli-spike-" + randomHex(4),
	})
	logf("  HTTP %d %s, %v\n", status, oneLine(string(body), 120), err)

	logf("\n== 3. one table read, no profile filter: every profile's announcement\n")
	list, err := b.get(ctx, "/rest/v1/profile_settings_blobs?select=profile_id,settings_json,updated_at&platform=eq."+platform)
	logf("  GET /rest/v1/profile_settings_blobs?platform=eq.%s -> %s, %v\n", platform, oneLine(string(list), 400), err)

	logf("\n== 4. may a session write another profile index's row? (profile 2, which this account doesn't have)\n")
	status, body, err = a.post(ctx, "/rest/v1/rpc/sync_push_profile_settings_blob", map[string]any{
		"p_profile_id": 2, "p_platform": platform, "p_settings_json": announcement,
		"p_origin_client_id": "peli-spike-" + randomHex(4),
	})
	logf("  push to profile 2 -> HTTP %d %s, %v\n", status, oneLine(string(body), 200), err)
	rows2, _ := a.rows(ctx, 2)
	logf("  rows at profile 2 now: %s\n", a.red.apply(rows2))
	logf("  B pulls profile 2: %s\n", oneLine(must(b.pull(ctx, 2, platform)), 300))

	logf("\n== 5. undo both rows\n")
	for _, index := range []int{1, 2} {
		status, body, err := a.delete(ctx, "?profile_id=eq."+itoa(index)+"&platform=eq."+platform)
		logf("  DELETE profile %d platform %s -> HTTP %d %s, %v\n", index, platform, status, oneLine(string(body), 100), err)
	}

	logf("\n== 6. the account after\n")
	p1, _ = a.rows(ctx, 1)
	p2, _ = a.rows(ctx, 2)
	logf("  profile 1: %s\n  profile 2: %s\n", a.red.apply(tuple(p1)), a.red.apply(tuple(p2)))
	logf("  identical to before: %v\n", before == tuple(p1)+" | "+tuple(p2))
	listing, _ := b.get(ctx, "/rest/v1/profile_settings_blobs?select=profile_id&platform=eq."+platform)
	logf("  B's listing of %q now: %s\n", platform, oneLine(string(listing), 200))
	return nil
}

// twoProfiles runs the design flow over the account's two profiles: the host's
// profile leaves an announcement, the other profile finds it, both the "read
// the host's row" and the "write a row per profile" variants. Undone.
func twoProfiles() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	a, doneA, err := openSession(ctx)
	if err != nil {
		return err
	}
	defer doneA()
	b, doneB, err := openSession(ctx)
	if err != nil {
		return err
	}
	defer doneB()
	logf := a.red.printf

	const platform = "peli-spike"
	announcement := map[string]any{"v": 1, "party": map[string]any{
		"id": "11111111-2222-4333-8444-555555555555", "code": "TEST01", "host": "peli-spike",
		"media": map[string]any{"type": "movie", "meta_id": "tt0000001", "title": "Peli spike"},
		"at":    1764200000000,
	}}
	list := "/rest/v1/profile_settings_blobs?select=profile_id,settings_json,updated_at&platform=eq." + platform

	logf("== 1. the account's profiles\n")
	_, prof, err := a.post(ctx, "/rest/v1/rpc/sync_pull_profiles", map[string]any{})
	if err != nil {
		return err
	}
	logf("  %s\n", oneLine(a.red.apply(string(prof)), 400))
	stored, _ := a.get(ctx, list)
	logf("  announcements stored now: %s\n\n", oneLine(string(stored), 200))

	logf("== 2. profile 1 (the host's) writes the announcement\n")
	start := time.Now()
	status, body, err := a.post(ctx, "/rest/v1/rpc/sync_push_profile_settings_blob", map[string]any{
		"p_profile_id": 1, "p_platform": platform, "p_settings_json": announcement,
		"p_origin_client_id": "peli-spike-" + randomHex(4),
	})
	logf("  HTTP %d %v, %v\n\n", status, time.Since(start).Round(time.Millisecond), err)

	logf("== 3. profile 2's own row, before anything writes it\n")
	logf("  pull p_profile_id=2: %s\n\n", oneLine(must(b.pull(ctx, 2, platform)), 200))

	logf("== 4. variant A: the other profile reads the host's row\n")
	start = time.Now()
	got, err := b.pull(ctx, 1, platform)
	logf("  pull p_profile_id=1 (the host's profile): %s (%v), %v\n", oneLine(got, 300),
		time.Since(start).Round(time.Millisecond), err)
	logf("  carries the code: %v\n\n", strings.Contains(got, "TEST01"))

	logf("== 5. variant B: the host writes a row per profile, so each profile reads its own\n")
	for _, index := range []int{1, 2} {
		status, body, err = a.post(ctx, "/rest/v1/rpc/sync_push_profile_settings_blob", map[string]any{
			"p_profile_id": index, "p_platform": platform, "p_settings_json": announcement,
			"p_origin_client_id": "peli-spike-" + randomHex(4),
		})
		logf("  write profile %d -> HTTP %d, %v\n", index, status, err)
	}
	own, err := b.pull(ctx, 2, platform)
	logf("  profile 2 pulls its own row: %s, %v\n\n", oneLine(own, 300), err)

	logf("== 6. one GET lists the whole account's live parties\n")
	start = time.Now()
	all, err := a.get(ctx, list)
	logf("  %s (%v), %v\n\n", oneLine(string(all), 600), time.Since(start).Round(time.Millisecond), err)

	logf("== 7. a stale code is caught by the RPC the join already needs\n")
	status, body, err = a.post(ctx, "/rest/v1/rpc/watch_party_preview", map[string]any{"p_code": "TEST01"})
	logf("  watch_party_preview(TEST01) -> HTTP %d %s, %v\n\n", status, oneLine(string(body), 200), err)

	logf("== 8. undo: delete both rows, and check both profiles are clean\n")
	for _, index := range []int{1, 2} {
		status, _, err := a.delete(ctx, "?profile_id=eq."+itoa(index)+"&platform=eq."+platform)
		logf("  DELETE profile %d -> HTTP %d, %v\n", index, status, err)
	}
	stored, _ = a.get(ctx, list)
	logf("  announcements stored now: %s\n", string(stored))
	one, _ := a.rows(ctx, 1)
	two, _ := a.rows(ctx, 2)
	logf("  profile 1 rows: %s\n  profile 2 rows: %s\n", a.red.apply(one), a.red.apply(two))
	return nil
}

// timing measures the reads a Join page would make, on an empty answer (no
// rows for the platform right now), three times each.
func timing() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	a, done, err := openSession(ctx)
	if err != nil {
		return err
	}
	defer done()
	a.red.printf("read timings, 3 rounds, no rows stored right now\n")
	for i := 0; i < 3; i++ {
		start := time.Now()
		_, _, err := a.post(ctx, "/rest/v1/rpc/sync_pull_profile_settings_blob", map[string]any{
			"p_profile_id": 1, "p_platform": "peli-spike",
		})
		pull := time.Since(start).Round(time.Millisecond)
		start = time.Now()
		_, getErr := a.get(ctx, "/rest/v1/profile_settings_blobs?select=profile_id,settings_json,updated_at&platform=eq.peli-spike")
		list := time.Since(start).Round(time.Millisecond)
		a.red.printf("  round %d: pull RPC %v, listing GET %v (%v, %v)\n", i+1, pull, list, err, getErr)
	}
	start := time.Now()
	rows, _ := a.rows(ctx, 1)
	a.red.printf("  profile row list (GET, 2 rows): %v, %d bytes\n", time.Since(start).Round(time.Millisecond), len(rows))
	return nil
}

// afterRow drops our platform's row from a row list, so it can be compared
// with the baseline.
func afterRow(rows string, platform string) string {
	var parsed []map[string]any
	if json.Unmarshal([]byte(rows), &parsed) != nil {
		return rows
	}
	kept := make([]map[string]any, 0, len(parsed))
	for _, row := range parsed {
		if row["platform"] != platform {
			kept = append(kept, row)
		}
	}
	out, _ := json.Marshal(kept)
	return string(out)
}

func itoa(n int) string { return strconv.Itoa(n) }

func must(s string, err error) string {
	if err != nil {
		return "error: " + err.Error()
	}
	return s
}

func mustRows(s string, err error) string {
	if err != nil {
		return "error: " + err.Error()
	}
	return s
}

// rows lists the account's settings-blob rows: profile, platform and when.
func (a *client) rows(ctx context.Context, profile int) (string, error) {
	data, err := a.get(ctx, "/rest/v1/profile_settings_blobs?select=profile_id,platform,updated_at&profile_id=eq."+itoa(profile)+"&order=platform.asc")
	return string(data), err
}

// pull reads a settings blob through the sync RPC a client would use.
func (a *client) pull(ctx context.Context, profile int, platform string) (string, error) {
	body := map[string]any{"p_profile_id": profile}
	if platform != "" {
		body["p_platform"] = platform
	}
	_, answer, err := a.post(ctx, "/rest/v1/rpc/sync_pull_profile_settings_blob", body)
	return a.red.apply(string(answer)), err
}

// delete removes rows with a PostgREST filter, and returns the answer.
func (a *client) delete(ctx context.Context, filter string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, a.base+"/rest/v1/profile_settings_blobs"+filter, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Apikey", a.key)
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("User-Agent", userAgent)
	res, err := a.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, answer, nil
}

// rawPath prints one path's OpenAPI entry verbatim, so the shape of a
// function's parameters can be read before trusting a parser.
func rawPath(path string) error {
	email, password := os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD")
	if email == "" || password == "" {
		return fmt.Errorf("set NUVIO_EMAIL and NUVIO_PASSWORD")
	}
	base := strings.TrimRight(os.Getenv("NUVIO_URL"), "/")
	if base == "" {
		base = nuvio.DefaultURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	red := &redactor{}
	red.add(email, "<email>")
	red.add(password, "<password>")
	key, err := discoveryKey(ctx, base)
	if err != nil {
		return err
	}
	red.add(key, "<apikey>")
	c := nuvio.New(base, "0.0.0-party-account-sync-spike")
	s, err := c.SignInWithPassword(ctx, email, password)
	if err != nil {
		return err
	}
	red.add(s.AccessToken, "<access-token>")
	red.add(s.RefreshToken, "<refresh-token>")
	red.add(s.UserID, "<user-uuid>")
	defer func() {
		if err := c.SignOut(context.Background(), s); err != nil {
			fmt.Fprintf(os.Stderr, "sign out: %v\n", err)
			return
		}
		fmt.Print("signed out\n")
	}()
	api := &client{base: base, key: key, red: red, http: &http.Client{Timeout: 20 * time.Second}, token: s.AccessToken}
	data, err := api.get(ctx, "/rest/v1/")
	if err != nil {
		return err
	}
	var doc struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return err
	}
	entry, ok := doc.Paths[path]
	if !ok {
		return fmt.Errorf("no such path %q", path)
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, entry, "", "  "); err != nil {
		return err
	}
	fmt.Println(pretty.String())
	return nil
}

// getPath reads a REST path with the session and prints the answer, redacted.
func getPath(path string) error {
	api, done, err := openSession(context.Background())
	if err != nil {
		return err
	}
	defer done()
	data, err := api.get(context.Background(), path)
	if err != nil {
		return err
	}
	fmt.Println(api.red.apply(string(data)))
	return nil
}

// openSession signs in and returns a client plus the cleanup that signs out.
func openSession(ctx context.Context) (*client, func(), error) {
	email, password := os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD")
	if email == "" || password == "" {
		return nil, nil, fmt.Errorf("set NUVIO_EMAIL and NUVIO_PASSWORD")
	}
	base := strings.TrimRight(os.Getenv("NUVIO_URL"), "/")
	if base == "" {
		base = nuvio.DefaultURL
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	red := &redactor{}
	red.add(email, "<email>")
	red.add(password, "<password>")
	key, err := discoveryKey(ctx, base)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	red.add(key, "<apikey>")
	c := nuvio.New(base, "0.0.0-party-account-sync-spike")
	s, err := c.SignInWithPassword(ctx, email, password)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	red.add(s.AccessToken, "<access-token>")
	red.add(s.RefreshToken, "<refresh-token>")
	red.add(s.UserID, "<user-uuid>")
	done := func() {
		cancel()
		if err := c.SignOut(context.Background(), s); err != nil {
			fmt.Fprintf(os.Stderr, "sign out: %v\n", err)
			return
		}
		fmt.Print("signed out\n")
	}
	return &client{base: base, key: key, red: red, http: &http.Client{Timeout: 20 * time.Second}, token: s.AccessToken}, done, nil
}

// rpcPath calls a function with a JSON body given on the command line.
func rpcPath(path, body string) error {
	api, done, err := openSession(context.Background())
	if err != nil {
		return err
	}
	defer done()
	var in any
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		return err
	}
	status, answer, err := api.post(context.Background(), path, in)
	if err != nil {
		return err
	}
	fmt.Printf("HTTP %d\n%s\n", status, api.red.apply(string(answer)))
	return nil
}
