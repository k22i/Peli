package main

import (
	"bytes"
	"os/exec"
	"strings"
	"testing"
)

// The iOS build is debrid-only (ADR-0055): torrent streaming, plugins, watch
// parties, auto-update, first-mouse handling and the libmpv desktop engine
// must not be compiled into it (App Store review), and the dependency list is
// where that shows. `go list` needs no iOS SDK, so this runs on macOS and
// Linux like the rest of the tests.

// goList runs `go list` for the main package with env added.
func goList(t *testing.T, env []string, format string, args ...string) string {
	t.Helper()
	cmd := exec.Command("go", append([]string{"list", "-f", format}, append(args, ".")...)...)
	cmd.Env = append(cmd.Environ(), env...)
	var out, errs bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errs
	if err := cmd.Run(); err != nil {
		t.Fatalf("go list %v: %v\n%s", args, err, errs.String())
	}
	return out.String()
}

var iosEnv = []string{"GOOS=ios", "GOARCH=arm64", "CGO_ENABLED=1"}

// Packages (or parts of an import path) that must not be in the iOS build.
var notOniOS = []string{
	"anacrolix",
	"dop251/goja",
	"go-llsqlite",
	"pion/",
	"/internal/torrent",
	"/internal/plugins",
	"/internal/party",
	"/internal/updates",
	"/internal/firstmouse",
	// Wails' updater providers (GitHub releases and so on). The updater
	// package itself is the one exception below.
	"wails/v3/pkg/updater/providers",
}

// Wails' own application package imports pkg/updater on every platform, so
// it is in the iOS build whatever Peli does; nothing of Peli's calls it there
// (the updates service is not registered). Recorded in ADR-0055.
const wailsUpdater = "github.com/wailsapp/wails/v3/pkg/updater"

func TestIOSBuildLeavesOutTheDesktopOnlyPieces(t *testing.T) {
	deps := strings.Fields(goList(t, iosEnv, "{{.ImportPath}}", "-deps", "-tags", "ios"))
	if len(deps) < 100 {
		t.Fatalf("go list -deps gave %d packages; is the iOS listing broken?", len(deps))
	}
	have := map[string]bool{}
	for _, dep := range deps {
		have[dep] = true
		for _, bad := range notOniOS {
			if strings.Contains(dep+"/", bad) {
				t.Errorf("the iOS build imports %s (%q is desktop-only)", dep, bad)
			}
		}
	}
	for _, want := range []string{
		"github.com/k22i/Peli/internal/playback",
		"github.com/k22i/Peli/internal/player", // its iOS Service only, below
		"github.com/k22i/Peli/internal/iosplayer",
		"github.com/k22i/Peli/internal/store",
		"github.com/k22i/Peli/internal/secrets",
		"github.com/wailsapp/wails/v3/pkg/application",
	} {
		if !have[want] {
			t.Errorf("the iOS build should import %s", want)
		}
	}
	if !have[wailsUpdater] {
		t.Logf("Wails' application package no longer imports %s on iOS; drop the exception", wailsUpdater)
	}

	// internal/player is in, but only types.go and service_ios.go: no libmpv,
	// no AppKit, no cgo.
	for _, pkg := range []string{"internal/player", "internal/secrets", "internal/iosplayer"} {
		out := strings.TrimSpace(listPackage(t, iosEnv, "github.com/k22i/Peli/"+pkg, "ios"))
		parts := strings.Split(out, "|")
		if len(parts) != 5 {
			t.Fatalf("%s: unexpected go list output %q", pkg, out)
		}
		// internal/iosplayer is the iOS engine (ADR-0055): libmpv's client
		// API from Go, the UIKit video host, and the device and motion
		// sensor reads the iPhone's rotation uses, and nothing else with cgo.
		if pkg == "internal/iosplayer" {
			if parts[1] != "[device.go engine.go mpv.go]" || parts[2] != "[]" || parts[3] != "[host_ios.m motion_ios.m]" || parts[4] != "[host_ios.h]" {
				t.Errorf("internal/iosplayer files changed: %s; update the boundary test on purpose", out)
			}
			continue
		}
		for i, kind := range []string{"", "cgo", "C", "Objective-C", "header"} {
			// secrets has one cgo file: Peli's own Keychain items, since
			// Wails' fix the class at WhenUnlocked (ADR-0057).
			if pkg == "internal/secrets" && kind == "cgo" && parts[i] == "[keychain_ios.go]" {
				continue
			}
			if i > 0 && parts[i] != "[]" {
				t.Errorf("%s has %s files on iOS: %s", pkg, kind, parts[i])
			}
		}
		if pkg == "internal/player" && parts[0] != "[service_ios.go types.go]" {
			t.Errorf("internal/player compiles %s on iOS, want only [service_ios.go types.go]", parts[0])
		}
	}
}

// internal/iosauth is the in-app sign-in sheet (ADR-0059): one cgo file and
// its Objective-C, for ASWebAuthenticationSession, and nothing more.
func TestIOSAuthSheetFiles(t *testing.T) {
	out := strings.TrimSpace(listPackage(t, iosEnv, "github.com/k22i/Peli/internal/iosauth", "ios"))
	if want := "[]|[auth_ios.go]|[]|[auth_ios.m]|[auth_ios.h]"; out != want {
		t.Errorf("internal/iosauth files changed: %s, want %s; update the boundary test on purpose", out, want)
	}
}

// listPackage lists one package's source files for env.
func listPackage(t *testing.T, env []string, pkg string, tags ...string) string {
	t.Helper()
	cmd := exec.Command("go", "list", "-tags", strings.Join(tags, ","), "-f",
		"{{.GoFiles}}|{{.CgoFiles}}|{{.CFiles}}|{{.MFiles}}|{{.HFiles}}", pkg)
	cmd.Env = append(cmd.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list %s: %v\n%s", pkg, err, out)
	}
	return string(out)
}

// The test above could pass for the wrong reason (a broken listing, a
// renamed package), so the desktop build must still have all of it.
func TestDesktopBuildKeepsTheDesktopOnlyPieces(t *testing.T) {
	have := map[string]bool{}
	for _, dep := range strings.Fields(goList(t, nil, "{{.ImportPath}}", "-deps")) {
		have[dep] = true
	}
	for _, want := range []string{
		"github.com/anacrolix/torrent",
		"github.com/dop251/goja",
		"github.com/k22i/Peli/internal/torrent",
		"github.com/k22i/Peli/internal/plugins",
		"github.com/k22i/Peli/internal/party",
		"github.com/k22i/Peli/internal/updates",
		"github.com/k22i/Peli/internal/firstmouse",
		"github.com/k22i/Peli/internal/player",
		"github.com/k22i/Peli/internal/playback",
		wailsUpdater,
	} {
		if !have[want] {
			t.Errorf("the desktop build should import %s", want)
		}
	}
	// And the libmpv half of the player is there to leave out.
	out := listPackage(t, nil, "github.com/k22i/Peli/internal/player")
	if !strings.Contains(out, "mpv.go") {
		t.Errorf("the desktop player should compile mpv.go, got %s", out)
	}
}
