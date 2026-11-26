package nuvio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
)

// The settings blobs Nuvio's clients keep per profile, in
// /rest/v1/profile_settings_blobs: one JSON object per (profile, platform),
// written with sync_push_profile_settings_blob (+ _guarded for
// compare-and-set) and read back with sync_pull_profile_settings_blob or the
// table.
//
// Peli keeps a row of its own under PlatformPeli (ADR-0067): a platform key
// Nuvio's clients never ask for, so the row is invisible to them, and it
// holds nothing but Peli's own party announcement. Nuvio's own platforms
// (desktop, tv, …) hold the user's real settings for that kind of device and
// are never written.
//
// A push replaces the whole blob, so a caller that keeps more than one key in
// the row reads it first and copies back what it isn't changing.

// PlatformPeli is the platform key Peli's own row uses. Never one of
// Nuvio's: pushing a real platform's blob replaces the user's actual
// settings for that kind of device.
const PlatformPeli = "peli"

// SettingsBlob is one row's JSON object, key by key, so a caller can keep
// the keys it doesn't read. It is an object rather than a
// json.RawMessage because the contract checks read fields by their type,
// and a raw message reads as an array of bytes.
type SettingsBlob = map[string]json.RawMessage

// SettingsBlobRow is one profile's blob for one platform, as the table and
// the pull answer it. UpdatedAt is the server's, the value a guarded push
// compares against ("2026-11-26T08:30:39.257987+00:00").
type SettingsBlobRow struct {
	ProfileID int          `json:"profile_id"`
	Settings  SettingsBlob `json:"settings_json"`
	UpdatedAt string       `json:"updated_at"`
}

// ProfileSettings reads profile index's blob for platform, and whether there
// is one. p_platform is always sent: the one-argument call is ambiguous
// between the function's two overloads (PGRST203).
func (c *Client) ProfileSettings(ctx context.Context, s Session, index int, platform string) (SettingsBlobRow, bool, error) {
	rows := []SettingsBlobRow{}
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_pull_profile_settings_blob", s.AccessToken, map[string]any{
		"p_profile_id": index, "p_platform": platform,
	}, &rows)
	if err != nil || len(rows) == 0 {
		return SettingsBlobRow{}, false, err
	}
	return rows[0], true, nil
}

// ProfileSettingsList reads every profile's blob for platform: one request
// for the whole account, since row-level security limits the table to the
// account's own rows.
func (c *Client) ProfileSettingsList(ctx context.Context, s Session, platform string) ([]SettingsBlobRow, error) {
	rows := []SettingsBlobRow{}
	query := url.Values{
		"select":   {"profile_id,settings_json,updated_at"},
		"platform": {"eq." + platform},
	}
	err := c.call(ctx, http.MethodGet, "/rest/v1/profile_settings_blobs?"+query.Encode(), s.AccessToken, nil, &rows)
	return rows, err
}

// PushProfileSettings replaces profile index's blob for platform with blob.
func (c *Client) PushProfileSettings(ctx context.Context, s Session, index int, platform string, blob SettingsBlob) error {
	return c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_push_profile_settings_blob", s.AccessToken, map[string]any{
		"p_profile_id": index, "p_platform": platform, "p_settings_json": blob,
		"p_origin_client_id": c.originID,
	}, nil)
}

// PushProfileSettingsGuarded replaces the blob only while the row is still
// the one expectedUpdatedAt names, and answers the new updated_at. A row that
// changed in the meantime (or isn't there) is refused with 409 PT409: read it
// again and retry.
//
// The answer is a bare JSON string, so the contract has nothing to check it
// against; TestContract still reaches it and checks the refusals.
func (c *Client) PushProfileSettingsGuarded(ctx context.Context, s Session, index int, platform string, blob SettingsBlob, expectedUpdatedAt string) (string, error) {
	var updated string
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_push_profile_settings_blob_guarded", s.AccessToken, map[string]any{
		"p_profile_id": index, "p_platform": platform, "p_settings_json": blob,
		"p_expected_updated_at": expectedUpdatedAt,
	}, &updated)
	return updated, err
}

// DeleteProfileSettings removes profile index's blob for platform. There is
// no delete function: it deletes the table row.
func (c *Client) DeleteProfileSettings(ctx context.Context, s Session, index int, platform string) error {
	query := url.Values{
		"profile_id": {"eq." + strconv.Itoa(index)},
		"platform":   {"eq." + platform},
	}
	return c.call(ctx, http.MethodDelete, "/rest/v1/profile_settings_blobs?"+query.Encode(), s.AccessToken, nil, nil)
}
