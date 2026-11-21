package player

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

const testDownloadID = "0123456789abcdef0123456789abcdef"

func fileURL(p string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(p)}).String()
}

func TestDownloadSubtitlePath(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	subs := filepath.Join(root, testDownloadID, "subs")
	if err := os.MkdirAll(subs, 0o755); err != nil {
		t.Fatal(err)
	}
	good := filepath.Join(subs, "0.srt")
	if err := os.WriteFile(good, []byte(srtText), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	notID := filepath.Join(root, "movies", "subs")
	if err := os.MkdirAll(notID, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(notID, "0.srt"), []byte(srtText), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(subs, "link.srt")
	linked := os.Symlink(outside, link) == nil

	want, _ := filepath.EvalSymlinks(good)
	if got, err := downloadSubtitlePath(fileURL(good)); err != nil || got != want {
		t.Errorf("a download's subtitle: got %q, %v; want %q", got, err, want)
	}
	cases := [][2]string{
		{"outside a subs folder", fileURL(outside)},
		{"a folder not named by a download id", fileURL(filepath.Join(notID, "0.srt"))},
		{"a missing file", fileURL(filepath.Join(subs, "missing.srt"))},
		{"a folder", fileURL(subs)},
		{"a traversal", fileURL(filepath.Join(subs, "..", "..", "secret.txt"))},
		{"a remote host", "file://example.com" + filepath.ToSlash(good)},
		{"a relative path", "file:subs/0.srt"},
		{"http", "http://example.com/0.srt"},
	}
	if linked {
		cases = append(cases, [2]string{"a symlink out of the folder", fileURL(link)})
	}
	for _, c := range cases {
		if got, err := downloadSubtitlePath(c[1]); err == nil {
			t.Errorf("%s: got %q, want it refused", c[0], got)
		}
	}
}

const srtText = "1\n00:00:00,000 --> 00:00:03,000\nBonjour\n"
