package account

import (
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
	"github.com/k22i/Sinag/internal/store"
)

// kidsFixture signs in and makes Nuvio's profile 3 a kids profile with PIN
// 1234, as its parent would. Kevin (index 1) is the parent's profile, with no
// PIN, and the kids profile is current and unlocked.
func kidsFixture(t *testing.T) (f fixture, kevin, kids store.Profile) {
	t.Helper()
	f, _, _ = signedIn(t)
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")
	kevin, kids = profileAt(t, f, 1), profileAt(t, f, 3)
	if err := f.service.UnlockProfile(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SetKids(t.Context(), kids.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SwitchProfile(t.Context(), kids.ID); err != nil {
		t.Fatal(err)
	}
	return f, kevin, profileAt(t, f, 3)
}

func wantCode(t *testing.T, what string, err error, want string) {
	t.Helper()
	if got := code(t, err); got != want {
		t.Fatalf("%s: code = %q, want %q (err: %v)", what, got, want, err)
	}
}

func TestSetKidsNeedsAPIN(t *testing.T) {
	f, _, _ := signedIn(t)
	kevin := profileAt(t, f, 1)
	// Kevin has no PIN to leave a kids profile with.
	_, err := f.service.SetKids(t.Context(), kevin.ID, true)
	wantCode(t, "no PIN", err, CodeKidsNeedsPIN)
	// The Guest isn't a Nuvio profile.
	guest, _ := f.store.SwitchToGuest()
	_, err = f.service.SetKids(t.Context(), guest.ID, true)
	wantCode(t, "Guest", err, CodeKidsNeedsPIN)

	// A locked profile first needs its PIN.
	kids := profileAt(t, f, 3)
	_, err = f.service.SetKids(t.Context(), kids.ID, true)
	wantCode(t, "locked", err, CodeProfileLocked)
}

func TestLeavingKidsNeedsTheParentPIN(t *testing.T) {
	f, kevin, kids := kidsFixture(t)
	if !kids.Kids {
		t.Fatalf("Kids isn't a kids profile: %+v", kids)
	}

	_, err := f.service.SwitchProfile(t.Context(), kevin.ID)
	wantCode(t, "switch", err, CodeParentPINRequired)

	err = f.service.ApproveParent(t.Context(), kids.ID, "0000")
	wantCode(t, "wrong PIN", err, CodeWrongPIN)
	if _, err := f.service.SwitchProfile(t.Context(), kevin.ID); err == nil {
		t.Fatal("a wrong PIN let the kids profile be left")
	}

	if err := f.service.ApproveParent(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SwitchProfile(t.Context(), kevin.ID); err != nil {
		t.Fatal(err)
	}
	if current, _ := f.store.CurrentProfile(); current.ID != kevin.ID {
		t.Fatalf("current = %+v, want Kevin", current)
	}

	// Going back in locks it again: leaving asks for the PIN anew.
	if _, err := f.service.SwitchProfile(t.Context(), kids.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.SwitchProfile(t.Context(), kevin.ID)
	wantCode(t, "switch after re-entering", err, CodeParentPINRequired)
}

func TestParentPINExpires(t *testing.T) {
	f, kevin, kids := kidsFixture(t)
	now := time.Now()
	f.service.now = func() time.Time { return now }

	if err := f.service.ApproveParent(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(parentWindow + time.Second)
	_, err := f.service.SwitchProfile(t.Context(), kevin.ID)
	wantCode(t, "after the window", err, CodeParentPINRequired)

	if err := f.service.ApproveParent(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(parentWindow - time.Second)
	if _, err := f.service.SwitchProfile(t.Context(), kevin.ID); err != nil {
		t.Fatal(err)
	}
}

// Nothing about the account or its profiles may change from a kids profile
// without the parent PIN, or the kid could walk out through the side door.
func TestKidsCannotChangeProfiles(t *testing.T) {
	f, kevin, kids := kidsFixture(t)
	ctx := t.Context()

	_, err := f.service.EditProfile(ctx, kevin.ID, ProfileEdit{Name: "Hacked"})
	wantCode(t, "edit another", err, CodeParentPINRequired)
	_, err = f.service.EditProfile(ctx, kids.ID, ProfileEdit{Name: "Hacked"})
	wantCode(t, "edit itself", err, CodeParentPINRequired)
	_, err = f.service.AddProfile(ctx, ProfileEdit{Name: "New", AvatarColor: "#43A047"})
	wantCode(t, "add", err, CodeParentPINRequired)
	wantCode(t, "delete", f.service.DeleteProfile(ctx, kevin.ID), CodeParentPINRequired)
	wantCode(t, "set PIN", f.service.SetProfilePIN(ctx, kevin.ID, "1111", ""), CodeParentPINRequired)
	_, err = f.service.SetKids(ctx, kids.ID, false)
	wantCode(t, "turn kids off", err, CodeParentPINRequired)
	wantCode(t, "scope", f.service.SetKidsScope(ctx, kids.ID, store.KidsScope{}), CodeParentPINRequired)
	wantCode(t, "sign out", f.service.SignOut(ctx), CodeParentPINRequired)
	_, err = f.service.SignIn(ctx, "me@example.com", nuviotest.Password)
	wantCode(t, "sign in", err, CodeParentPINRequired)
	// The store's own shortcuts are shut too.
	if _, err := f.store.SwitchToGuest(); err == nil {
		t.Fatal("SwitchToGuest left the kids profile")
	}
	if err := f.store.SetCurrentProfile(kevin.ID); err == nil {
		t.Fatal("SetCurrentProfile left the kids profile")
	}

	// Nothing changed.
	if got := profileAt(t, f, 1); got.Name != "Kevin" {
		t.Fatalf("Kevin = %+v", got)
	}
	if profiles, _ := f.store.Profiles(); len(profiles) != 2 {
		t.Fatalf("profiles = %+v", profiles)
	}
	if signedIn, _ := f.service.Status(); !signedIn.SignedIn {
		t.Fatal("signed out")
	}

	// With the parent PIN, the parent can.
	if err := f.service.ApproveParent(ctx, kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.EditProfile(ctx, kevin.ID, ProfileEdit{Name: "Kevin K"}); err != nil {
		t.Fatal(err)
	}
}

// From the parent's own profile, a kids profile can't be edited, deleted or
// turned off without its PIN either.
func TestKidsProfileNeedsItsPINToChange(t *testing.T) {
	f, kevin, kids := kidsFixture(t)
	ctx := t.Context()
	if err := f.service.ApproveParent(ctx, kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SwitchProfile(ctx, kevin.ID); err != nil {
		t.Fatal(err)
	}

	// Unlocking lets it be entered, not changed.
	if err := f.service.UnlockProfile(ctx, kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	_, err := f.service.EditProfile(ctx, kids.ID, ProfileEdit{Name: "Little ones"})
	wantCode(t, "edit", err, CodeParentPINRequired)
	wantCode(t, "delete", f.service.DeleteProfile(ctx, kids.ID), CodeParentPINRequired)
	_, err = f.service.SetKids(ctx, kids.ID, false)
	wantCode(t, "turn off", err, CodeParentPINRequired)
	// Kevin's own profile is free to change.
	if _, err := f.service.EditProfile(ctx, kevin.ID, ProfileEdit{Name: "Kevin K"}); err != nil {
		t.Fatal(err)
	}

	if err := f.service.ApproveParent(ctx, kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	edited, err := f.service.EditProfile(ctx, kids.ID, ProfileEdit{Name: "Little ones"})
	if err != nil {
		t.Fatal(err)
	}
	// Nuvio's copy has no kids flag, and the edit keeps ours.
	if !edited.Kids || !profileAt(t, f, 3).Kids {
		t.Fatalf("editing lost the kids flag: %+v", edited)
	}
	wantCode(t, "clear PIN", f.service.ClearProfilePIN(ctx, kids.ID, "1234"), CodeKidsKeepsPIN)

	off, err := f.service.SetKids(ctx, kids.ID, false)
	if err != nil || off.Kids || profileAt(t, f, 3).Kids {
		t.Fatalf("SetKids(false) = %+v, %v", off, err)
	}
	// An ordinary profile again: its PIN can go, and it can be left freely.
	if err := f.service.ClearProfilePIN(ctx, kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
}

func TestTurningKidsOnLocksTheProfileAtOnce(t *testing.T) {
	f, _, _ := signedIn(t)
	ctx := t.Context()
	f.backend.SetProfilePIN(t, "me@example.com", 3, "1234")
	kevin, kids := profileAt(t, f, 1), profileAt(t, f, 3)
	// The parent is in the profile they're about to hand over.
	if err := f.service.UnlockProfile(ctx, kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SwitchProfile(ctx, kids.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SetKids(ctx, kids.ID, true); err != nil {
		t.Fatal(err)
	}
	_, err := f.service.SwitchProfile(ctx, kevin.ID)
	wantCode(t, "switch", err, CodeParentPINRequired)
}

func TestKidsFlagSurvivesSigningInAgain(t *testing.T) {
	f, _, kids := kidsFixture(t)
	if err := f.service.ApproveParent(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	if !profileAt(t, f, 3).Kids {
		t.Fatal("signing in again lost the kids flag")
	}
}

func TestKidsScopeLimitsAddons(t *testing.T) {
	f, kevin, kids := kidsFixture(t)
	db := store.Opened(f.store)
	cinemeta := store.Addon{URL: "https://cinemeta.example/manifest.json", Enabled: true}
	adult := store.Addon{URL: "https://adult.example/manifest.json", Enabled: true}
	for _, id := range []uint64{kevin.ID, kids.ID} {
		if err := db.SetAddons(id, []store.Addon{cinemeta, adult}); err != nil {
			t.Fatal(err)
		}
	}
	ctx := t.Context()
	wantCode(t, "scope without the PIN", f.service.SetKidsScope(ctx, kids.ID, store.KidsScope{Addons: []string{cinemeta.URL}}), CodeParentPINRequired)
	if err := f.service.ApproveParent(ctx, kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if err := f.service.SetKidsScope(ctx, kids.ID, store.KidsScope{Addons: []string{cinemeta.URL}}); err != nil {
		t.Fatal(err)
	}

	got, err := f.store.VisibleAddons(kids.ID)
	if err != nil || len(got) != 1 || got[0].URL != cinemeta.URL {
		t.Fatalf("the kids profile sees %+v, %v", got, err)
	}
	if got, _ := f.store.VisibleAddons(kevin.ID); len(got) != 2 {
		t.Fatalf("Kevin sees %+v", got)
	}
	// Only a kids profile has a scope.
	wantCode(t, "scope on Kevin", f.service.SetKidsScope(ctx, kevin.ID, store.KidsScope{}), CodeInvalidProfile)
}
