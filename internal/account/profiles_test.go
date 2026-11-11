package account

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/nuvio/nuviotest"
	"github.com/k22i/Peli/internal/store"
)

// profileAt returns the local profile linked to Nuvio index.
func profileAt(t *testing.T, f fixture, index int) store.Profile {
	t.Helper()
	profiles, err := f.store.Profiles()
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(profiles, func(p store.Profile) bool { return p.NuvioIndex != nil && *p.NuvioIndex == index })
	if i < 0 {
		t.Fatalf("no profile at index %d in %+v", index, profiles)
	}
	return profiles[i]
}

// remoteAt returns the account's profile at index on the backend, or nil.
func remoteAt(f fixture, index int) map[string]any {
	for _, p := range f.backend.Profiles("me@example.com") {
		if p["profile_index"] == float64(index) {
			return p
		}
	}
	return nil
}

func TestAvatars(t *testing.T) {
	f := newFixture(t)
	// Signed out: the catalog is public.
	avatars, err := f.service.Avatars(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(avatars) != 2 || avatars[0].ID != "a1" || avatars[0].Name != "Otto" || avatars[0].Color != "#0BB5AE" ||
		avatars[0].Image != f.backend.URL+"/storage/v1/object/public/avatars/animals/otto-v1.png" {
		t.Fatalf("avatars = %+v", avatars)
	}
}

func TestEditProfile(t *testing.T) {
	f, _, _ := signedIn(t)
	kids := profileAt(t, f, 3)
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")
	if err := f.service.UnlockProfile(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}

	saved, err := f.service.EditProfile(t.Context(), kids.ID, ProfileEdit{Name: "  Little ones ", AvatarID: "a1", AvatarColor: "#e53935"})
	if err != nil {
		t.Fatal(err)
	}
	want := store.Profile{
		ID: kids.ID, Name: "Little ones", NuvioIndex: kids.NuvioIndex, AvatarColor: "#E53935",
		Avatar: f.backend.URL + "/storage/v1/object/public/avatars/animals/otto-v1.png",
	}
	if saved.ID != want.ID || saved.Name != want.Name || saved.Avatar != want.Avatar || saved.AvatarColor != want.AvatarColor || *saved.NuvioIndex != 3 {
		t.Fatalf("saved = %+v, want %+v", saved, want)
	}
	if local, _ := store.Opened(f.store).Profile(kids.ID); local.Name != "Little ones" || local.Avatar != want.Avatar {
		t.Fatalf("local = %+v", local)
	}
	// In Nuvio, with the stock avatar replacing its custom image, and the
	// other profile and the PIN untouched.
	remote := remoteAt(f, 3)
	if remote["name"] != "Little ones" || remote["avatar_id"] != "a1" || remote["avatar_url"] != nil ||
		remote["avatar_color_hex"] != "#E53935" || remote["pin_enabled"] != true || remote["uses_primary_addons"] != true {
		t.Fatalf("remote = %v", remote)
	}
	if main := remoteAt(f, 1); main["name"] != "Kevin" || main["avatar_color_hex"] != "#33B5E0" {
		t.Fatalf("profile 1 = %v", main)
	}
}

func TestEditProfileNameOnly(t *testing.T) {
	f, _, _ := signedIn(t)
	main := profileAt(t, f, 1)
	f.backend.FailAvatars.Store(true)

	// No catalog needed, and the image is kept.
	saved, err := f.service.EditProfile(t.Context(), main.ID, ProfileEdit{Name: "Kev"})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Name != "Kev" || saved.Avatar != main.Avatar || saved.AvatarColor != main.AvatarColor {
		t.Fatalf("saved = %+v, was %+v", saved, main)
	}
	if body := f.backend.Body("/rest/v1/rpc/sync_patch_profile"); len(body) != 2 {
		t.Fatalf("patch = %v, want the name alone", body)
	}
}

func TestEditProfileRefusals(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit ProfileEdit
		code string
	}{
		{"empty name", ProfileEdit{Name: "  "}, CodeInvalidProfile},
		{"long name", ProfileEdit{Name: strings.Repeat("é", maxNameLength+1)}, CodeInvalidProfile},
		{"bad colour", ProfileEdit{Name: "Kev", AvatarColor: "red"}, CodeInvalidProfile},
		{"unknown avatar", ProfileEdit{Name: "Kev", AvatarID: "gone"}, CodeInvalidProfile},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _, _ := signedIn(t)
			before := len(f.backend.Calls())
			_, err := f.service.EditProfile(t.Context(), profileAt(t, f, 1).ID, tc.edit)
			if got := code(t, err); got != tc.code {
				t.Fatalf("code = %q, want %q (err: %v)", got, tc.code, err)
			}
			for _, call := range f.backend.Calls()[before:] {
				if strings.Contains(call, "sync_patch_profile") {
					t.Fatal("patched Nuvio")
				}
			}
		})
	}
}

func TestEditProfileDeletedElsewhere(t *testing.T) {
	f, _, _ := signedIn(t)
	kids := profileAt(t, f, 3)
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")
	if err := f.service.UnlockProfile(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	f.backend.SetProfiles(t, "me@example.com", `[{"profile_index":1,"name":"Kevin","avatar_color_hex":"#33B5E0"}]`)
	_, err := f.service.EditProfile(t.Context(), kids.ID, ProfileEdit{Name: "Kids 2"})
	if got := code(t, err); got != CodeProfileNotFound {
		t.Fatalf("code = %q (err: %v)", got, err)
	}
}

// Offline or signed out, a Nuvio profile's change is refused rather than
// queued, and nothing changes on this device.
func TestProfileChangesNeedNuvio(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(fixture)
		code  string
	}{
		{"offline", func(f fixture) { f.backend.Close() }, CodeUnreachable},
		{"session ended", func(f fixture) {
			f.backend.Revoke()
			f.backend.ExpireAccessTokens()
		}, CodeSignedOut},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _, _ := signedIn(t)
			kids := profileAt(t, f, 3)
			f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")
			if err := f.service.UnlockProfile(t.Context(), kids.ID, "1234"); err != nil {
				t.Fatal(err)
			}
			tc.setup(f)

			_, err := f.service.EditProfile(t.Context(), kids.ID, ProfileEdit{Name: "Kids 2"})
			if got := code(t, err); got != tc.code {
				t.Fatalf("edit: code = %q, want %q (err: %v)", got, tc.code, err)
			}
			_, err = f.service.AddProfile(t.Context(), ProfileEdit{Name: "New", AvatarColor: "#43A047"})
			if got := code(t, err); got != tc.code {
				t.Fatalf("add: code = %q, want %q (err: %v)", got, tc.code, err)
			}
			err = f.service.DeleteProfile(t.Context(), kids.ID)
			if got := code(t, err); got != tc.code {
				t.Fatalf("delete: code = %q, want %q (err: %v)", got, tc.code, err)
			}
			profiles, _ := f.store.Profiles()
			if len(profiles) != 2 || profiles[1].Name != "Kids" {
				t.Fatalf("profiles = %+v", profiles)
			}
		})
	}
}

func TestAddProfile(t *testing.T) {
	f, _, _ := signedIn(t)
	current, _ := f.store.CurrentProfile()

	added, err := f.service.AddProfile(t.Context(), ProfileEdit{Name: " Guests ", AvatarID: "a7", AvatarColor: "#43a047"})
	if err != nil {
		t.Fatal(err)
	}
	// The lowest free index, with its stock avatar.
	if added.ID == 0 || added.Name != "Guests" || *added.NuvioIndex != 2 || added.AvatarColor != "#43A047" ||
		added.Avatar != f.backend.URL+"/storage/v1/object/public/avatars/animals/pip-v1.png" {
		t.Fatalf("added = %+v", added)
	}
	if local := profileAt(t, f, 2); local.ID != added.ID {
		t.Fatalf("local = %+v", local)
	}
	// Adding doesn't switch.
	if now, _ := f.store.CurrentProfile(); now.ID != current.ID {
		t.Fatalf("current = %+v, want %+v", now, current)
	}
	// The backend replaces the list on a push, so the others survive only
	// because they were pushed whole.
	remote := f.backend.Profiles("me@example.com")
	if len(remote) != 3 || remote[1]["name"] != "Guests" || remote[1]["avatar_id"] != "a7" {
		t.Fatalf("remote = %v", remote)
	}
	if kids := remote[2]; kids["name"] != "Kids" || kids["avatar_url"] != "https://img/a7.png" ||
		kids["avatar_color_hex"] != "#F5A623" || kids["uses_primary_addons"] != true || kids["pin_enabled"] != true {
		t.Fatalf("profile 3 = %v", kids)
	}
}

func TestAddProfileWhenFull(t *testing.T) {
	f, _, _ := signedIn(t)
	var six []string
	for i := 1; i <= nuvio.MaxProfiles; i++ {
		six = append(six, fmt.Sprintf(`{"profile_index":%d,"name":"P","avatar_color_hex":"#33B5E0"}`, i))
	}
	f.backend.SetProfiles(t, "me@example.com", "["+strings.Join(six, ",")+"]")

	_, err := f.service.AddProfile(t.Context(), ProfileEdit{Name: "Seventh", AvatarColor: "#43A047"})
	if got := code(t, err); got != CodeProfilesFull {
		t.Fatalf("code = %q (err: %v)", got, err)
	}
	if f.backend.Body("/rest/v1/rpc/sync_push_profiles") != nil {
		t.Fatal("pushed profiles")
	}
	if profiles, _ := f.store.Profiles(); len(profiles) != 2 {
		t.Fatalf("profiles = %+v", profiles)
	}
}

func TestFreeIndex(t *testing.T) {
	two := 2
	remote := []nuvio.Profile{{Index: 1}, {Index: 3}}
	if got := freeIndex(remote, nil); got != 2 {
		t.Fatalf("freeIndex = %d, want 2", got)
	}
	// Index 2 is still on this device after another device deleted it.
	if got := freeIndex(remote, []store.Profile{{NuvioIndex: &two}}); got != 4 {
		t.Fatalf("freeIndex = %d, want 4", got)
	}
	full := []nuvio.Profile{{Index: 1}, {Index: 2}, {Index: 3}, {Index: 4}, {Index: 5}, {Index: 6}}
	if got := freeIndex(full, nil); got != 0 {
		t.Fatalf("freeIndex = %d, want 0", got)
	}
}

func TestDeleteProfile(t *testing.T) {
	f, _, _ := signedIn(t)
	kids := profileAt(t, f, 3)
	db := store.Opened(f.store)
	if err := db.SetCurrentProfile(kids.ID); err != nil {
		t.Fatal(err)
	}
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")
	if err := f.service.UnlockProfile(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}

	if err := f.service.DeleteProfile(t.Context(), kids.ID); err != nil {
		t.Fatal(err)
	}
	if remote := f.backend.Profiles("me@example.com"); len(remote) != 1 || remote[0]["name"] != "Kevin" {
		t.Fatalf("remote = %v", remote)
	}
	if _, err := db.Profile(kids.ID); !errors.Is(err, store.ErrProfileNotFound) {
		t.Fatalf("local profile: err = %v", err)
	}
	// It was current, so the oldest left takes over.
	if current, _ := f.store.CurrentProfile(); *current.NuvioIndex != 1 {
		t.Fatalf("current = %+v", current)
	}

	// Profile 1 is the primary, and now the last.
	err := f.service.DeleteProfile(t.Context(), profileAt(t, f, 1).ID)
	if got := code(t, err); got != CodePrimaryProfile {
		t.Fatalf("code = %q (err: %v)", got, err)
	}
}

func TestDeleteLastProfile(t *testing.T) {
	f := newFixture(t)
	f.backend.SetProfiles(t, "me@example.com", `[{"profile_index":2,"name":"Only","avatar_color_hex":"#33B5E0"}]`)
	if _, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	err := f.service.DeleteProfile(t.Context(), profileAt(t, f, 2).ID)
	if got := code(t, err); got != CodeLastProfile {
		t.Fatalf("code = %q (err: %v)", got, err)
	}
	if len(f.backend.Profiles("me@example.com")) != 1 {
		t.Fatal("deleted in Nuvio")
	}
}

// The Guest is local-only: renaming and removing it never reach Nuvio.
func TestGuestProfileStaysLocal(t *testing.T) {
	f, _, _ := signedIn(t)
	guest, err := f.store.SwitchToGuest()
	if err != nil {
		t.Fatal(err)
	}
	before := len(f.backend.Calls())

	renamed, err := f.service.EditProfile(t.Context(), guest.ID, ProfileEdit{Name: "Visitors", AvatarID: "a1", AvatarColor: "#E53935"})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Name != "Visitors" || !renamed.Guest || renamed.Avatar != "" || renamed.AvatarColor != "" {
		t.Fatalf("renamed = %+v", renamed)
	}
	if err := f.service.DeleteProfile(t.Context(), guest.ID); err != nil {
		t.Fatal(err)
	}
	if calls := f.backend.Calls()[before:]; len(calls) != 0 {
		t.Fatalf("calls = %q, want none", calls)
	}
}
