//go:build !ios

package player

import (
	"context"
	"testing"

	"github.com/k22i/Peli/internal/previews"
	"github.com/k22i/Peli/internal/streams"
)

// A preview decoder opens a local file, knows its length and takes a
// keyframe from it. A path is no http URL, so the bounded-request option is
// left off (the file is on the disk).
func TestOpenPreview(t *testing.T) {
	ctx := context.Background()
	g, err := OpenPreview(ctx, streams.Source{URL: "testdata/clip.mp4"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if d := g.Duration(); d < 2 || d > 4 {
		t.Errorf("duration %v s, want between 2 and 4", d)
	}
	f, err := g.Grab(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if f.Image == nil {
		t.Fatal("no image")
	}
	if w := f.Image.Bounds().Dx(); w != previews.Width {
		t.Errorf("image %d px wide, want %d", w, previews.Width)
	}
	if h := f.Image.Bounds().Dy(); h <= 0 {
		t.Errorf("image height %d, want more than 0", h)
	}
	// A keyframe seek lands on the keyframe at or before the second asked
	// for, and reports the time it landed on.
	if f.At < 0 || f.At > 1.5 {
		t.Errorf("frame at %v s, want between 0 and 1.5", f.At)
	}
	// Closing twice is what the previews service does on End after a failed
	// open: it must not panic.
	g.Close()
}

// A grab whose context has ended returns at once with its error, rather than
// waiting out the seek: the service cancels the thumbnails a hover left
// behind.
func TestGrabWithCancelledContext(t *testing.T) {
	ctx := context.Background()
	g, err := OpenPreview(ctx, streams.Source{URL: "testdata/clip.mp4"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := g.Grab(cancelled, 1); err == nil {
		t.Fatal("Grab with a cancelled context returned no error")
	}
}
