//go:build darwin

package updates

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/sys/unix"
)

// installed is the running Peli.app. Wails' helper replaces the whole bundle
// once Peli has quit, then opens it again.
type installed struct{}

func (installed) Where() (string, Reason) {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		return "", NotInstalled
	}
	return bundleWhere(exe)
}

// bundleWhere is the bundle exe runs in, if Peli can replace it.
func bundleWhere(exe string) (string, Reason) {
	macOS := filepath.Dir(exe)
	bundle := filepath.Dir(filepath.Dir(macOS))
	if filepath.Base(macOS) != "MacOS" || filepath.Ext(bundle) != ".app" {
		return "", NotInstalled
	}
	// The disk image, and the read-only copy macOS runs an app from when it
	// was opened where it was downloaded (App Translocation).
	var fs unix.Statfs_t
	if err := unix.Statfs(bundle, &fs); err != nil || fs.Flags&unix.MNT_RDONLY != 0 ||
		strings.Contains(bundle, "/AppTranslocation/") {
		return "", NotInstalled
	}
	// The helper moves the bundle aside and puts the new one in its place.
	if unix.Access(filepath.Dir(bundle), unix.W_OK) != nil || unix.Access(bundle, unix.W_OK) != nil {
		return "", ReadOnly
	}
	return bundle, ""
}

func (installed) Check(staged, target, version string) error {
	if filepath.Ext(staged) != ".app" {
		return fmt.Errorf("%w: %s isn't an app", ErrMismatch, filepath.Base(staged))
	}
	got, err := plistValue(staged, "CFBundleShortVersionString")
	if err != nil {
		return err
	}
	// The feed's version isn't signed, the app is: an old release offered
	// under a new version number stops here.
	if got != version {
		return fmt.Errorf("%w: the feed said %s, the app is %s", ErrMismatch, version, got)
	}
	want, err := plistValue(target, "CFBundleIdentifier")
	if err != nil {
		return err
	}
	if id, err := plistValue(staged, "CFBundleIdentifier"); err != nil || id != want {
		return fmt.Errorf("%w: bundle id %q, not %q", ErrMismatch, id, want)
	}
	if out, err := exec.Command("codesign", "--verify", "--deep", "--strict", staged).CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", ErrMismatch, bytes.TrimSpace(out))
	}
	// Signed by the same team as this copy, so the keychain items keep
	// trusting Peli (ADR-0053). An ad-hoc copy has no team to keep.
	team, err := teamID(target)
	if err != nil || team == "" {
		return err
	}
	req := fmt.Sprintf(`anchor apple generic and certificate leaf[subject.OU] = "%s"`, team)
	if out, err := exec.Command("codesign", "--verify", "--deep", "--strict", "-R="+req, staged).CombinedOutput(); err != nil {
		return fmt.Errorf("%w: not signed by team %s: %s", ErrMismatch, team, bytes.TrimSpace(out))
	}
	return nil
}

func plistValue(app, key string) (string, error) {
	out, err := exec.Command("plutil", "-extract", key, "raw", "-o", "-",
		filepath.Join(app, "Contents", "Info.plist")).Output()
	if err != nil {
		return "", fmt.Errorf("%w: no %s in %s", ErrMismatch, key, filepath.Base(app))
	}
	return strings.TrimSpace(string(out)), nil
}

var teamLine = regexp.MustCompile(`(?m)^TeamIdentifier=(\S+)$`)

// teamID is the team that signed app, or "" for an ad-hoc signature.
func teamID(app string) (string, error) {
	out, err := exec.Command("codesign", "-d", "--verbose=2", app).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("updates: reading %s's signature: %s", filepath.Base(app), bytes.TrimSpace(out))
	}
	m := teamLine.FindSubmatch(out)
	if m == nil || string(m[1]) == "not" {
		return "", nil
	}
	return string(m[1]), nil
}
