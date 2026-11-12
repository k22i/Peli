//go:build darwin

package updates

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBundleWhere(t *testing.T) {
	dir := t.TempDir()
	bundle := filepath.Join(dir, "Peli.app")
	exe := filepath.Join(bundle, "Contents", "MacOS", "peli")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}

	if got, reason := bundleWhere(exe); got != bundle || reason != "" {
		t.Fatalf("bundleWhere(%q) = %q, %q; want the bundle", exe, got, reason)
	}
	if _, reason := bundleWhere(filepath.Join(dir, "peli")); reason != NotInstalled {
		t.Fatalf("outside a bundle: reason %q, want %q", reason, NotInstalled)
	}
	if _, reason := bundleWhere("/AppTranslocation/x/Peli.app/Contents/MacOS/peli"); reason != NotInstalled {
		t.Fatalf("translocated: reason %q, want %q", reason, NotInstalled)
	}

	// The helper can't move the bundle out of a folder it can't write to.
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	if _, reason := bundleWhere(exe); reason != ReadOnly {
		t.Fatalf("read-only folder: reason %q, want %q", reason, ReadOnly)
	}
}
