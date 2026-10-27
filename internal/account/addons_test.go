package account

import (
	"testing"

	"github.com/k22i/Sinag/internal/store"
)

// The addon manager's edits go through the kids guard: a kids profile's
// addons, or any while one is in use, change only with the parent PIN (#32).
func TestAddonEditsNeedTheParentPIN(t *testing.T) {
	f, kevin, kids := kidsFixture(t)
	ctx := t.Context()
	cinemeta := store.Addon{URL: "https://cinemeta.example/manifest.json", Enabled: true}

	for _, id := range []uint64{kids.ID, kevin.ID} {
		wantCode(t, "install", f.service.InstallAddon(ctx, id, cinemeta), CodeParentPINRequired)
	}
	if err := f.service.ApproveParent(ctx, kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if err := f.service.InstallAddon(ctx, kids.ID, cinemeta); err != nil {
		t.Fatal(err)
	}
	wantCode(t, "install twice", f.service.InstallAddon(ctx, kids.ID, cinemeta), CodeAddonInstalled)
	if err := f.service.EnableAddon(ctx, kids.ID, cinemeta.URL, false); err != nil {
		t.Fatal(err)
	}
	if err := f.service.MoveAddon(ctx, kids.ID, cinemeta.URL, 0); err != nil {
		t.Fatal(err)
	}
	if err := f.service.RemoveAddon(ctx, kids.ID, cinemeta.URL); err != nil {
		t.Fatal(err)
	}
	wantCode(t, "remove twice", f.service.RemoveAddon(ctx, kids.ID, cinemeta.URL), CodeAddonNotFound)
}

// A Nuvio profile that uses the primary's addons is marked so here, which
// sends its addon sync to profile 1 (#32).
func TestUsesPrimaryAddonsIsKept(t *testing.T) {
	f, _, _ := signedIn(t)
	if profileAt(t, f, 1).UsesPrimaryAddons {
		t.Fatal("the primary is marked as sharing its own addons")
	}
	if !profileAt(t, f, 3).UsesPrimaryAddons {
		t.Fatal("profile 3 uses the primary's addons in the fake, but isn't marked")
	}
}
