package nuviotest

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

// ContractURL names the environment variable that points the contract and
// integration tests (#33) at a real backend: a self-hosted Nuvio
// (NuvioMedia/self-host) whose signup is open, never api.nuvio.tv.
const ContractURL = "PELI_CONTRACT_URL"

// Backend is what the contract and integration tests run against: this
// package's fake, or the real backend at $PELI_CONTRACT_URL. The same cases
// run on both, so the fake can't drift from the backend it stands in for.
type Backend struct {
	URL string
	// The fake, or nil on a real backend.
	Fake *Server
}

// NewBackend returns the backend at $PELI_CONTRACT_URL, or a new fake.
func NewBackend(t testing.TB) *Backend {
	t.Helper()
	url := strings.TrimRight(os.Getenv(ContractURL), "/")
	if url == "" {
		s := NewServer(t)
		return &Backend{URL: s.URL, Fake: s}
	}
	if strings.Contains(url, "api.nuvio.tv") {
		t.Fatalf("%s points at live; the contract tests sign up throwaway accounts, so use a self-hosted backend", ContractURL)
	}
	return &Backend{URL: url}
}

// Account returns a new, empty account's email and password, with a profile
// at index 1. On a real backend it signs one up, which self-host confirms at
// once.
func (b *Backend) Account(t testing.TB) (email, password string) {
	t.Helper()
	email = "peli-contract-" + randomHex(6) + "@example.com"
	if b.Fake != nil {
		b.Fake.SetProfiles(t, email, `[{"profile_index":1,"name":"Contract","avatar_color_hex":"#33B5E0","avatar_id":null,"avatar_url":null,"uses_primary_addons":false,"uses_primary_plugins":false,"pin_enabled":false,"pin_locked_until":null}]`)
		return email, Password
	}
	password = "Peli-" + randomHex(12)
	key := b.key(t)
	var session struct {
		AccessToken string `json:"access_token"`
	}
	b.post(t, "/auth/v1/signup", key, key, map[string]any{"email": email, "password": password}, &session)
	if session.AccessToken == "" {
		t.Fatalf("signing up at %s gave no session: is autoconfirm off?", b.URL)
	}
	b.post(t, "/rest/v1/rpc/sync_push_profiles", key, session.AccessToken, map[string]any{
		"p_profiles": []map[string]any{{
			"profile_index": 1, "name": "Contract", "avatar_color_hex": "#33B5E0",
			"uses_primary_addons": false, "uses_primary_plugins": false,
		}},
		"p_client_max_profiles": 6,
	}, nil)
	return email, password
}

// key reads the backend's publishable key from its discovery document.
func (b *Backend) key(t testing.TB) string {
	t.Helper()
	res, err := http.Get(b.URL + "/.well-known/nuvio")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var doc struct {
		PublishableKey string `json:"publishable_key"`
	}
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil || doc.PublishableKey == "" {
		t.Fatalf("%s/.well-known/nuvio has no publishable key: %v", b.URL, err)
	}
	return doc.PublishableKey
}

func (b *Backend) post(t testing.TB, path, key, bearer string, in, out any) {
	t.Helper()
	body, _ := json.Marshal(in)
	req, _ := http.NewRequest(http.MethodPost, b.URL+path, bytes.NewReader(body))
	req.Header.Set("Apikey", key)
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		t.Fatalf("POST %s: HTTP %d: %s", path, res.StatusCode, data)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
