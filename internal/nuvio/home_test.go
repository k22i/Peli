package nuvio

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
)

// ownServer returns a client pointed at a fake as a custom server, signed in.
func ownServer(t *testing.T) (*nuviotest.Server, *Client, Session) {
	t.Helper()
	b := nuviotest.NewServer(t)
	c := newTestClient("https://nuvio.invalid")
	c.UseServer(b.URL, "")
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	fail(t, err)
	return b, c, s
}

const layout = `{"items":[{"key":"org.cinemeta:movie:top","addon_id":"org.cinemeta","type":"movie","catalog_id":"top","enabled":true,"order":0,"custom_title":"","is_collection":false,"collection_id":""}],"hide_unreleased_content":true,"hide_catalog_underline":false}`

func TestHomeLayoutSync(t *testing.T) {
	b, c, s := signedIn(t)
	ctx := t.Context()

	got, err := c.HomeLayout(ctx, s, 1)
	if err != nil || got != nil {
		t.Fatalf("no layout yet: %v, %v", got, err)
	}
	// Nuvio's apps share one platform; desktop rows are never read.
	b.SetHomeLayout(t, "me@example.com", 1, "home_catalog_shared", layout)
	b.SetHomeLayout(t, "me@example.com", 1, "desktop", `{"items":[]}`)
	got, err = c.HomeLayout(ctx, s, 1)
	fail(t, err)
	want := map[string]json.RawMessage{}
	fail(t, json.Unmarshal([]byte(layout), &want))
	if !reflect.DeepEqual(compact(t, got), compact(t, want)) {
		t.Fatalf("layout = %s", compact(t, got))
	}
	if body := b.Body("/rest/v1/rpc/sync_pull_home_catalog_settings"); body["p_platform"] != "home_catalog_shared" {
		t.Fatalf("pulled platform %v", body["p_platform"])
	}
}

func TestCollectionsSync(t *testing.T) {
	b, c, s := signedIn(t)
	got, err := c.Collections(t.Context(), s, 1)
	if err != nil || got != nil {
		t.Fatalf("no collections yet: %v, %v", got, err)
	}
	b.SetCollections(t, "me@example.com", 1, `[{"id":"c1","title":"Streaming","folders":[]}]`)
	got, err = c.Collections(t.Context(), s, 1)
	if err != nil || len(got) != 1 || got[0]["title"] != "Streaming" {
		t.Fatalf("collections = %v, %v", got, err)
	}
}

func TestHomePushesOnOwnServer(t *testing.T) {
	b, c, s := ownServer(t)
	ctx := t.Context()
	fail(t, c.PushHomeLayout(ctx, s, 2, json.RawMessage(layout)))
	if got := b.HomeLayout("me@example.com", 2, "home_catalog_shared"); got["hide_unreleased_content"] != true {
		t.Fatalf("pushed layout = %v", got)
	}
	fail(t, c.PushCollections(ctx, s, 2, json.RawMessage(`[{"id":"c1","title":"Anime"}]`)))
	if got := b.SyncedCollections("me@example.com", 2); len(got) != 1 {
		t.Fatalf("pushed collections = %v", got)
	}
	// And they come back on a pull.
	pulled, err := c.Collections(ctx, s, 2)
	if err != nil || len(pulled) != 1 || pulled[0]["title"] != "Anime" {
		t.Fatalf("pulled = %v, %v", pulled, err)
	}
}

// The PRD's rule: never push home layout or collections to Nuvio's backend.
// The client refuses before any request, on the URL it was made with and on
// any nuvio.tv host.
func TestHomePushesRefuseNuviosServer(t *testing.T) {
	b, c, s := signedIn(t) // the fake is this client's own, Nuvio's, server
	calls := len(b.Calls())
	if c.OwnServer() {
		t.Fatal("OwnServer on the URL the client was made with")
	}
	if err := c.PushHomeLayout(t.Context(), s, 1, json.RawMessage(layout)); !errors.Is(err, ErrNuviosServer) {
		t.Fatalf("layout push: err = %v", err)
	}
	if err := c.PushCollections(t.Context(), s, 1, json.RawMessage(`[]`)); !errors.Is(err, ErrNuviosServer) {
		t.Fatalf("collections push: err = %v", err)
	}
	if got := b.Calls()[calls:]; len(got) != 0 {
		t.Fatalf("refused pushes still called %v", got)
	}

	for _, url := range []string{DefaultURL, "https://API.nuvio.tv/", "https://staging.nuvio.tv", "https://nuvio.tv:8443"} {
		other := newTestClient("https://nuvio.invalid")
		other.UseServer(url, "key")
		if other.OwnServer() {
			t.Errorf("OwnServer at %s", url)
		}
	}
	other := newTestClient(DefaultURL)
	other.UseServer("https://nuvio.tv.example.com", "key")
	if !other.OwnServer() {
		t.Error("a host that only starts with nuvio.tv isn't Nuvio's")
	}
	// Back on the URL it was made with.
	other.UseServer(DefaultURL, "")
	if other.OwnServer() {
		t.Error("OwnServer after going back to Nuvio's server")
	}
}

func compact(t *testing.T, v map[string]json.RawMessage) string {
	t.Helper()
	data, err := json.Marshal(v)
	fail(t, err)
	var canonical any
	fail(t, json.Unmarshal(data, &canonical))
	data, err = json.Marshal(canonical)
	fail(t, err)
	return strings.TrimSpace(string(data))
}
