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

	configured := store.Addon{URL: "https://cinemeta.example/lang=fr/manifest.json", Enabled: true}
	for _, id := range []uint64{kids.ID, kevin.ID} {
		wantCode(t, "install", f.service.InstallAddon(ctx, id, cinemeta), CodeParentPINRequired)
		wantCode(t, "insert", f.service.InsertAddon(ctx, id, cinemeta, 0), CodeParentPINRequired)
		wantCode(t, "reconfigure", f.service.ReconfigureAddon(ctx, id, cinemeta.URL, configured), CodeParentPINRequired)
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
	if err := f.service.ReconfigureAddon(ctx, kids.ID, cinemeta.URL, configured); err != nil {
		t.Fatal(err)
	}
	if err := f.service.RemoveAddon(ctx, kids.ID, configured.URL); err != nil {
		t.Fatal(err)
	}
	wantCode(t, "remove twice", f.service.RemoveAddon(ctx, kids.ID, configured.URL), CodeAddonNotFound)
	wantCode(t, "reconfigure a removed addon", f.service.ReconfigureAddon(ctx, kids.ID, configured.URL, cinemeta), CodeAddonNotFound)
	if err := f.service.InsertAddon(ctx, kids.ID, configured, 0); err != nil {
		t.Fatal(err)
	}
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

// The same for plugins (#57): profile 1 never shares, and profile 3 does.
func TestUsesPrimaryPluginsIsKept(t *testing.T) {
	f, _, _ := signedIn(t)
	if profileAt(t, f, 1).UsesPrimaryPlugins {
		t.Fatal("the primary is marked as sharing its own plugins")
	}
	if !profileAt(t, f, 3).UsesPrimaryPlugins {
		t.Fatal("profile 3 uses the primary's plugins in the fake, but isn't marked")
	}
}

// The plugin service's edits go through the same guard as the addon manager's
// (#57): with a kids profile in use, even another profile's plugins change
// only with the parent PIN.
func TestEditorOfAsksForTheParentPIN(t *testing.T) {
	f, kevin, kids := kidsFixture(t)
	edit := EditorOf(f.service)
	ran := false
	set := func(*store.Store) error { ran = true; return nil }

	for _, id := range []uint64{kids.ID, kevin.ID} {
		wantCode(t, "edit", edit(id, set), CodeParentPINRequired)
	}
	if ran {
		t.Fatal("an edit ran without the parent PIN")
	}
	if err := f.service.ApproveParent(t.Context(), kids.ID, "1234"); err != nil {
		t.Fatal(err)
	}
	if err := edit(kevin.ID, set); err != nil || !ran {
		t.Fatalf("after approving: ran = %v, err = %v", ran, err)
	}
}
