package nuviotest

import (
	"cmp"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"
)

// The settings blobs of ADR-0067. Nuvio's table keeps one JSON blob per
// (profile, platform); the fake keeps it as sent, answers a pull with the one
// row, refuses a guarded push whose p_expected_updated_at isn't the row's
// (409 PT409), and lets the table be read and deleted. api.nuvio.tv did all
// of that on 2026-11-26 (spikes/party-account-sync/REPORT.md).

// blobKey is one row of the table.
type blobKey struct {
	profileKey
	platform string
}

// blobRow is what the fake keeps: the settings as sent, and the server's
// updated_at.
type blobRow struct {
	settings  any
	updatedAt string
}

// blobUpdated is the next server time, in live's format
// ("2026-11-26T08:30:39.257987+00:00"), always moving forward. s.mu is held.
func (s *Server) blobUpdated() string {
	s.sync.blobClock++
	start := time.Date(2026, 11, 26, 8, 30, 0, 0, time.UTC)
	return start.Add(time.Duration(s.sync.blobClock) * time.Millisecond).Format("2006-01-02T15:04:05.999999-07:00")
}

// blobJSON is a row as the table and the pull answer it, of the columns in
// select.
func (s *Server) blobJSON(key blobKey, row blobRow, columns []string) map[string]any {
	out := map[string]any{}
	for _, column := range columns {
		switch column {
		case "profile_id":
			out["profile_id"] = key.index
		case "platform":
			out["platform"] = key.platform
		case "settings_json":
			out["settings_json"] = row.settings
		case "updated_at":
			out["updated_at"] = row.updatedAt
		}
	}
	return out
}

// byProfileThenPlatform orders the table's rows as PostgREST lists them.
func byProfileThenPlatform(a, b blobKey) int {
	if a.index != b.index {
		return cmp.Compare(a.index, b.index)
	}
	return strings.Compare(a.platform, b.platform)
}

func columns(selects string) []string {
	if selects == "" {
		return []string{"profile_id", "platform", "settings_json", "updated_at"}
	}
	return strings.Split(selects, ",")
}

// SettingsBlobs returns every settings blob row of an account's profiles, in
// profile and platform order, as the server stores them.
func (s *Server) SettingsBlobs(email string) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]blobKey, 0, len(s.sync.blobs))
	for key := range s.sync.blobs {
		if key.user == UserID(email) {
			keys = append(keys, key)
		}
	}
	slices.SortFunc(keys, byProfileThenPlatform)
	rows := []map[string]any{}
	for _, key := range keys {
		rows = append(rows, s.blobJSON(key, s.sync.blobs[key], columns("")))
	}
	return rows
}

// settingsTable answers the profile_settings_blobs table: a read of the
// account's rows, narrowed to one platform, and a delete. s.mu is held.
func (s *Server) settingsTable(w http.ResponseWriter, r *http.Request, user string) {
	if user == "" {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"code":"42501","message":"permission denied for table profile_settings_blobs"}`))
		return
	}
	query := r.URL.Query()
	platform := strings.TrimPrefix(query.Get("platform"), "eq.")
	switch r.Method {
	case http.MethodGet:
		keys := make([]blobKey, 0, len(s.sync.blobs))
		for key := range s.sync.blobs {
			if key.user == user && (platform == "" || key.platform == platform) {
				keys = append(keys, key)
			}
		}
		slices.SortFunc(keys, byProfileThenPlatform)
		rows := []map[string]any{}
		for _, key := range keys {
			rows = append(rows, s.blobJSON(key, s.sync.blobs[key], columns(query.Get("select"))))
		}
		json.NewEncoder(w).Encode(rows)
	case http.MethodDelete:
		for key := range s.sync.blobs {
			if key.user == user && (platform == "" || key.platform == platform) {
				delete(s.sync.blobs, key)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// settingsRPC answers the three blob functions, as live does: the pull
// answers its rows, a push is 204, and a guarded push answers the new
// updated_at as a bare JSON string, or 409 while the row isn't the one
// expected. s.mu is held.
func (s *Server) settingsRPC(w http.ResponseWriter, rpc string, profile profileKey, body map[string]any) {
	platform, _ := body["p_platform"].(string)
	if platform == "" {
		postgrestError(w, http.StatusBadRequest, "P0001", "Invalid platform")
		return
	}
	if profile.index < 1 || profile.index > 6 {
		postgrestError(w, http.StatusBadRequest, "P0001", "Invalid profile id")
		return
	}
	key := blobKey{profile, platform}
	row, exists := s.sync.blobs[key]
	if rpc == "sync_pull_profile_settings_blob" {
		rows := []map[string]any{}
		if exists {
			rows = append(rows, s.blobJSON(key, row, columns("profile_id,settings_json,updated_at")))
		}
		json.NewEncoder(w).Encode(rows)
		return
	}
	if rpc == "sync_push_profile_settings_blob_guarded" {
		expected, _ := body["p_expected_updated_at"].(string)
		if !exists || row.updatedAt != expected {
			postgrestError(w, http.StatusConflict, "PT409", "Settings changed on another device. Reload and try again.")
			return
		}
	}
	s.sync.pushes[rpc]++
	updated := s.blobUpdated()
	s.sync.blobs[key] = blobRow{settings: body["p_settings_json"], updatedAt: updated}
	if rpc == "sync_push_profile_settings_blob_guarded" {
		json.NewEncoder(w).Encode(updated)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
