package player

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// Subtitles saved with a download (ADR-0064, #85) are played from disk, so a
// downloaded film plays with its subtitles offline. AddSubtitle takes them
// as file:// URLs, and only inside a download's own folder: the rule is a
// path of the form <any root>/<32-hex download id>/subs/<file>, after the
// path is cleaned and its symlinks resolved. The id folder is how
// internal/downloads names a job's folder, and the root may be anywhere (the
// user can choose the folder, so a "Downloads" segment or the configured
// folder can't be required: Service has no store to ask). Nothing else on the
// disk can be read through the player.

// errNotDownloadSubtitle is a file URL that isn't a download's subtitle file.
var errNotDownloadSubtitle = errors.New("player: not a download's subtitle file")

var downloadID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// isFileURL says whether raw names a local file, which AddSubtitle reads
// directly instead of downloading.
func isFileURL(raw string) bool {
	return len(raw) >= 5 && strings.EqualFold(raw[:5], "file:")
}

// downloadSubtitlePath is the real path of the subtitle file raw names, if
// it is a regular file in a download's subs folder.
func downloadSubtitlePath(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Scheme, "file") ||
		(u.Host != "" && !strings.EqualFold(u.Host, "localhost")) || u.Path == "" {
		return "", errNotDownloadSubtitle
	}
	p := u.Path
	// file:///C:/Users/… on Windows.
	if runtime.GOOS == "windows" && len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	p = filepath.FromSlash(p)
	if !filepath.IsAbs(p) {
		return "", errNotDownloadSubtitle
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(p))
	if err != nil {
		return "", errNotDownloadSubtitle
	}
	subs := filepath.Dir(real)
	if filepath.Base(subs) != "subs" || !downloadID.MatchString(filepath.Base(filepath.Dir(subs))) {
		return "", errNotDownloadSubtitle
	}
	info, err := os.Stat(real)
	if err != nil || !info.Mode().IsRegular() {
		return "", errNotDownloadSubtitle
	}
	return real, nil
}
