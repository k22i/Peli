package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIdentify(t *testing.T) {
	cases := map[string]string{
		"MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy": "MIT",
		"Apache License\nVersion 2.0, January 2004":                                                   "Apache-2.0",
		"GNU GENERAL PUBLIC LICENSE Version 3":                                                        "GPL",
		"GNU LESSER GENERAL PUBLIC LICENSE Version 2.1":                                               "LGPL",
		"GNU AFFERO GENERAL PUBLIC LICENSE":                                                           "AGPL",
		"SIL OPEN FONT LICENSE Version 1.1":                                                           "OFL-1.1",
		"something nobody has seen":                                                                   "unknown",
		// Wrapped across lines (cespare/xxhash, davecgh/go-spew).
		"MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining\na copy":     "MIT",
		"ISC License\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose": "ISC",
		// MPL 2.0 names the GNU licences as Secondary Licenses (anacrolix/torrent).
		"Mozilla Public License Version 2.0\n…\"Secondary License\" means either the GNU General Public License, Version 2.0, the GNU Lesser General Public License": "MPL-2.0",
	}
	for text, want := range cases {
		if got := identify(text); got != want {
			t.Errorf("identify(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestCheckPolicy(t *testing.T) {
	ok := []dep{{Name: "a", Licence: "MIT"}, {Name: "b", Licence: "OFL-1.1"}}
	if err := checkPolicy(ok); err != nil {
		t.Fatalf("permissive deps rejected: %v", err)
	}
	for _, licence := range []string{"GPL", "LGPL", "AGPL", "unknown", "GPL-3.0-only"} {
		err := checkPolicy(append(ok, dep{Kind: "go", Name: "bad", Licence: licence}))
		if err == nil || !strings.Contains(err.Error(), "bad") {
			t.Errorf("licence %q was not rejected: %v", licence, err)
		}
	}
}

func TestScan(t *testing.T) {
	cases := []struct {
		name    string
		data    string
		wantBad bool
	}{
		{"lgpl build", "configuration: --disable-gpl --enable-shared\x00LGPL version 2.1 or later\x00", false},
		{"lgpl 3", "LGPL version 3 or later", false},
		{"gpl configure", "configuration: --enable-gpl --enable-libx264", true},
		{"nonfree configure", "--enable-nonfree", true},
		{"gpl 2 licence string", "\x00GPL version 2 or later\x00", true},
		{"gpl 3 licence string", "\x00GPL version 3 or later\x00", true},
		{"nonfree licence string", "nonfree and unredistributable", true},
		{"unrelated", "hello", false},
	}
	for _, c := range cases {
		if got := len(scan("f", []byte(c.data))) > 0; got != c.wantBad {
			t.Errorf("%s: flagged = %v, want %v", c.name, got, c.wantBad)
		}
	}
}

func TestAuditBundle(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer

	if err := auditBundle(dir, &out); err != nil || !strings.Contains(out.String(), "nothing to check") {
		t.Fatalf("empty bundle: err = %v, out = %q", err, out.String())
	}

	lib := filepath.Join(dir, "Peli.app", "Contents", "Frameworks")
	if err := os.MkdirAll(lib, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(lib, "libmpv.2.dylib")

	out.Reset()
	if err := os.WriteFile(file, []byte("--disable-gpl\x00LGPL version 2.1 or later"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := auditBundle(dir, &out); err != nil || !strings.Contains(out.String(), "no GPL") {
		t.Fatalf("LGPL libmpv: err = %v, out = %q", err, out.String())
	}

	if err := os.WriteFile(file, []byte("--enable-gpl --enable-version3"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := auditBundle(dir, &out)
	if err == nil || !strings.Contains(err.Error(), "libmpv.2.dylib") {
		t.Fatalf("GPL libmpv: err = %v, want it to name the file", err)
	}
}

func TestLibmpvName(t *testing.T) {
	for _, n := range []string{"libmpv.2.dylib", "libmpv.so.2", "libmpv-2.dll", "mpv-2.dll", "libmpv.dylib"} {
		if !libmpvName.MatchString(n) {
			t.Errorf("%s not recognised as libmpv", n)
		}
	}
	if libmpvName.MatchString("peli") {
		t.Error("peli matched as libmpv")
	}
}

// #92: libmpv and each library built into it get a notice, versioned from
// build/libmpv/sources.txt.
func TestBuildLibmpv(t *testing.T) {
	n, err := build(filepath.Join("..", ".."), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Then the player's upscaling and sharpening shaders, which ship beside it.
	if len(n.Components) != 1+len(libmpvParts)+len(shaderParts) {
		t.Fatalf("%d components, want libmpv, %d parts and %d shaders",
			len(n.Components), len(libmpvParts), len(shaderParts))
	}
	for _, c := range n.Components {
		if c.Kind != "native" || c.Version == "" || c.Licence == "" || c.Text == "" {
			t.Errorf("incomplete notice: %+v", dep{Kind: c.Kind, Name: c.Name, Version: c.Version, Licence: c.Licence})
		}
		if bad := scan(c.Name, []byte(c.Text)); len(bad) > 0 {
			t.Errorf("%s: the audit would flag Peli's own binary: %v", c.Name, bad)
		}
	}
	if !strings.HasPrefix(n.Components[0].Version, "mpv ") {
		t.Errorf("libmpv version = %q", n.Components[0].Version)
	}
}
