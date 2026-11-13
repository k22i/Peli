package main

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Strings FFmpeg compiles into libavutil/libavcodec: its configure line and
// the licence it was built under (avutil_license()).
var (
	gplFlags = [][]byte{[]byte("--enable-gpl"), []byte("--enable-nonfree")}
	nonfree  = []byte("nonfree and unredistributable")
	// "GPL version 2 or later" is GPL; "LGPL version 2.1 or later" is fine.
	ffmpegLicence = regexp.MustCompile(`(L?)GPL version [0-9.]+ or later`)
	libmpvName    = regexp.MustCompile(`(?i)^(lib)?mpv(-[0-9]+)?\.(dll|dylib|so(\.[0-9]+)*)$|^libmpv[.0-9]*\.(dylib|so.*)$`)
)

// auditBundle scans every file under dir for a GPL or non-free FFmpeg build.
// ADR-0003: the only libmpv Peli may ship is our own LGPL one.
func auditBundle(dir string, out io.Writer) error {
	var problems []string
	var libmpvFound bool

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		// iOS embeds a framework: Frameworks/libmpv.framework/libmpv.
		if libmpvName.MatchString(d.Name()) ||
			(d.Name() == "libmpv" && strings.HasSuffix(filepath.Dir(path), "libmpv.framework")) {
			libmpvFound = true
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		problems = append(problems, scan(rel, data)...)
		return nil
	})
	if err != nil {
		return err
	}

	if len(problems) > 0 {
		return fmt.Errorf("GPL-only components in %s:\n  %s", dir, strings.Join(problems, "\n  "))
	}
	if libmpvFound {
		fmt.Fprintf(out, "libmpv in %s: no GPL or non-free FFmpeg configuration found\n", dir)
	} else {
		fmt.Fprintf(out, "no libmpv in %s: nothing to check yet (#92)\n", dir)
	}
	return nil
}

// scan returns what is wrong with one file's bytes.
func scan(name string, data []byte) []string {
	var problems []string
	for _, flag := range gplFlags {
		if bytes.Contains(data, flag) {
			problems = append(problems, fmt.Sprintf("%s: built with %s", name, flag))
		}
	}
	if bytes.Contains(data, nonfree) {
		problems = append(problems, fmt.Sprintf("%s: FFmpeg reports a non-free build", name))
	}
	for _, m := range ffmpegLicence.FindAll(data, -1) {
		if m[0] != 'L' {
			problems = append(problems, fmt.Sprintf("%s: FFmpeg reports %q", name, m))
		}
	}
	return problems
}
