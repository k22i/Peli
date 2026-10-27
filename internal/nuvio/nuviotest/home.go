package nuviotest

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// Home layouts and collections (#35), as self-host stores them: one JSON
// blob per profile, which the server never looks inside. A layout is kept
// per platform (Nuvio's apps share "home_catalog_shared"); collections have
// no platform. A push replaces the blob, and a pull of a profile with none
// answers no rows.

type homeKey struct {
	profileKey
	platform string
}

// HomeLayout returns the home layout of an account's profile on platform,
// or nil if it has none.
func (s *Server) HomeLayout(email string, index int, platform string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sync.home[homeKey{profileKey{UserID(email), index}, platform}]
}

// SetHomeLayout gives an account's profile the home layout settings, a JSON
// object, on platform, as another device would.
func (s *Server) SetHomeLayout(t testing.TB, email string, index int, platform, settings string) {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(settings), &v); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sync.home[homeKey{profileKey{UserID(email), index}, platform}] = v
}

// SyncedCollections returns the collections of an account's profile, or nil
// if it has none.
func (s *Server) SyncedCollections(email string, index int) []any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sync.colls[profileKey{UserID(email), index}]
}

// SetCollections gives an account's profile collections, a JSON array, as
// another device would.
func (s *Server) SetCollections(t testing.TB, email string, index int, collections string) {
	t.Helper()
	var v []any
	if err := json.Unmarshal([]byte(collections), &v); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sync.colls[profileKey{UserID(email), index}] = v
}

// pullHome answers the two pulls, and reports whether rpc was one. s.mu is
// held.
func (s *Server) pullHome(w http.ResponseWriter, rpc string, profile profileKey, body map[string]any) bool {
	rows := []map[string]any{}
	updated := time.Now().UTC().Format(time.RFC3339Nano)
	switch rpc {
	case "sync_pull_home_catalog_settings":
		platform, _ := body["p_platform"].(string)
		if platform == "" {
			platform = "tv"
		}
		if settings, ok := s.sync.home[homeKey{profile, platform}]; ok {
			rows = append(rows, map[string]any{
				"id": "00000000-0000-4000-8000-000000000035", "user_id": profile.user, "profile_id": profile.index,
				"platform": platform, "settings_json": settings, "updated_at": updated,
			})
		}
	case "sync_pull_collections":
		if collections, ok := s.sync.colls[profile]; ok {
			rows = append(rows, map[string]any{
				"profile_id": profile.index, "collections_json": collections, "updated_at": updated,
			})
		}
	default:
		return false
	}
	json.NewEncoder(w).Encode(rows)
	return true
}

// pushHome stores a layout or collections push. s.mu is held.
func (s *Server) pushHome(rpc string, profile profileKey, body map[string]any) {
	if rpc == "sync_push_collections" {
		collections, _ := body["p_collections_json"].([]any)
		if collections == nil {
			collections = []any{}
		}
		s.sync.colls[profile] = collections
		return
	}
	platform, _ := body["p_platform"].(string)
	if platform == "" {
		platform = "tv"
	}
	settings, _ := body["p_settings_json"].(map[string]any)
	s.sync.home[homeKey{profile, platform}] = settings
}
