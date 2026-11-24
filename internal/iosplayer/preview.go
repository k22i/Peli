//go:build ios

package iosplayer

import (
	"context"
	"errors"
	"fmt"
	"image"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/k22i/Peli/internal/previews"
	"github.com/k22i/Peli/internal/streams"
)

// A seek-bar preview is a second, headless libmpv on the file that plays: no
// window, no sound, paused, seeking to keyframes only (spikes/seek-previews/
// thumbs.go). It is a separate handle from the engine's, which keeps drawing
// the screen meanwhile.
const (
	// previewOpenTimeout is how long a file may take to decode its first
	// frame before the previews for it are given up.
	previewOpenTimeout = 20 * time.Second
	// previewGrabTimeout is the same for one keyframe seek. The spike took
	// about half a second per thumbnail on a 75 GB remux.
	previewGrabTimeout = 15 * time.Second
)

// previewGrabber is one headless decoder on one file (previews.Grabber). The
// previews service uses it from one goroutine at a time.
type previewGrabber struct {
	m         *mpv
	duration  float64
	gamma     string // video-params/gamma: "pq" and "hlg" are HDR
	primaries string
	once      sync.Once
}

// previewOptions is the headless handle's setup before mpv_initialize. A
// phone has less memory to spare than a Mac, so the decoder keeps one thread
// and copies frames off the GPU rather than holding zero-copy surfaces.
func previewOptions(url string) [][2]string {
	opts := [][2]string{
		{"config", "no"},
		{"terminal", "no"},
		{"vo", "null"},
		{"ao", "null"},
		{"aid", "no"},
		{"sid", "no"},
		{"pause", "yes"},
		// The file stays open at its end, so a late seek still finds one.
		{"keep-open", "always"},
		{"idle", "yes"},
		// A keyframe seek doesn't decode forward to the exact time asked
		// for: it is the thumbnail's own time that comes back.
		{"hr-seek", "no"},
		{"hwdec", "videotoolbox-copy"},
		// Skipping the deblocking filter halves HEVC decode time, and a
		// 320-pixel thumbnail doesn't show it.
		{"vd-lavc-skiploopfilter", "all"},
		{"vd-lavc-threads", "1"},
		// Read only what a keyframe needs: no read-ahead, no back buffer.
		{"cache", "no"},
		{"demuxer-readahead-secs", "0"},
		{"demuxer-max-bytes", "4MiB"},
		{"demuxer-max-back-bytes", "0"},
		// Down in the filter chain, so the frame handed back is small.
		{"vf", fmt.Sprintf("scale=w=%d:h=-2:flags=fast_bilinear", previews.Width)},
	}
	if strings.HasPrefix(url, "https://") || strings.HasPrefix(url, "http://") {
		// Bounded Range requests over http: a seek doesn't leave one
		// streaming the rest of the file into the socket. The spike's key
		// finding: 0.48 s per thumbnail with this, 1.3 s without.
		opts = append(opts, [2]string{"stream-lavf-o", "request_size=1048576"})
	}
	return opts
}

// OpenPreview opens a headless libmpv on source for seek-bar thumbnails
// (previews.Opener; docs/spikes/seek-previews.md).
func OpenPreview(ctx context.Context, source streams.Source, userAgent string) (previews.Grabber, error) {
	m, err := mpvCreate()
	if err != nil {
		return nil, fmt.Errorf("%w: %w", previews.ErrUnavailable, err)
	}
	// An option a build lacks isn't worth failing a thumbnail over, as in
	// loadFile's setup.
	for _, o := range previewOptions(source.URL) {
		if err := m.setOptionString(o[0], o[1]); err != nil {
			slog.Warn("iosplayer: preview option not set", "error", err)
		}
	}
	if err := m.initialize(); err != nil {
		m.destroy()
		return nil, fmt.Errorf("%w: mpv_initialize: %w", previews.ErrUnavailable, err)
	}
	// This handle must never call requestLogMessages: libmpv sends FFmpeg's
	// log to one handle per process, and the engine's needs it to see an
	// expired link.
	//
	// A download's file (Origin "download:<id>", ADR-0064) is a path on the
	// disk: no request headers or user agent to set.
	if !strings.HasPrefix(source.Origin, "download:") {
		ua := source.UserAgent
		if ua == "" {
			ua = userAgent
		}
		// Set as a list: a header's value may hold a comma, which mpv's
		// string form splits on.
		if err := m.setStringList("http-header-fields", source.HeaderFields()); err != nil {
			m.destroy()
			return nil, fmt.Errorf("%w: %w", previews.ErrUnavailable, err)
		}
		if err := m.setProperty("user-agent", ua); err != nil {
			m.destroy()
			return nil, fmt.Errorf("%w: %w", previews.ErrUnavailable, err)
		}
	}
	if err := m.command("loadfile", source.URL); err != nil {
		m.destroy()
		return nil, fmt.Errorf("%w: %w", previews.ErrUnavailable, err)
	}
	// A paused load sends playback-restart too, once the first frame is
	// decoded: that frame is the one a seek to 0 hands back.
	if err := waitRestart(ctx, m, previewOpenTimeout); err != nil {
		m.destroy()
		return nil, fmt.Errorf("%w: %w", previews.ErrUnavailable, err)
	}
	g := &previewGrabber{m: m}
	if g.duration, err = previewFloat(m, "duration"); err != nil {
		m.destroy()
		return nil, fmt.Errorf("%w: %w", previews.ErrUnavailable, err)
	}
	if g.gamma, err = m.getString("video-params/gamma"); err != nil {
		m.destroy()
		return nil, fmt.Errorf("%w: %w", previews.ErrUnavailable, err)
	}
	if g.primaries, err = m.getString("video-params/primaries"); err != nil {
		m.destroy()
		return nil, fmt.Errorf("%w: %w", previews.ErrUnavailable, err)
	}
	return g, nil
}

// previewFloat reads a property mpv gives as a string, as a number.
func previewFloat(m *mpv, name string) (float64, error) {
	s, err := m.getString(name)
	if err != nil {
		return 0, err
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("iosplayer: previews: %s: %w", name, err)
	}
	return v, nil
}

// waitRestart waits for playback-restart: the first frame after a load or a
// seek has been decoded. It gives up after limit, and returns ctx's error
// when ctx ends first, so a scrub the user has moved on from stops waiting.
func waitRestart(ctx context.Context, m *mpv, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("iosplayer: previews: no frame within %s", limit)
		}
		switch ev := m.waitEvent(0.25); ev.ID {
		case eventPlaybackRestart:
			return nil
		case eventEndFile:
			if ev.Error != 0 {
				return fmt.Errorf("iosplayer: previews: file failed: %w", mpvError(ev.Error))
			}
			return fmt.Errorf("iosplayer: previews: file ended (%s)", ev.Reason)
		case eventShutdown:
			// The handle is going away under us, from Close on another
			// goroutine.
			return errDestroyed
		}
	}
}

// previewImage turns screenshot-raw's bgr0 frame into an opaque image, as the
// desktop player's rawImage does for screenshots.
func previewImage(v any) (*image.NRGBA, error) {
	m, _ := v.(map[string]any)
	data, _ := m["data"].([]byte)
	w, _ := m["w"].(int64)
	h, _ := m["h"].(int64)
	stride, _ := m["stride"].(int64)
	if w <= 0 || h <= 0 || stride < w*4 || int64(len(data)) < stride*h {
		return nil, errors.New("iosplayer: no frame to take")
	}
	img := image.NewNRGBA(image.Rect(0, 0, int(w), int(h)))
	for y := range int(h) {
		src := data[int64(y)*stride:]
		dst := img.Pix[y*img.Stride:]
		for x := range int(w) {
			i := x * 4
			dst[i], dst[i+1], dst[i+2], dst[i+3] = src[i+2], src[i+1], src[i], 0xff
		}
	}
	return img, nil
}

// Duration is the file's length in seconds, known once opened.
func (g *previewGrabber) Duration() float64 { return g.duration }

// Grab takes the keyframe at or before sec.
func (g *previewGrabber) Grab(ctx context.Context, sec float64) (previews.Frame, error) {
	if err := ctx.Err(); err != nil {
		return previews.Frame{}, err
	}
	if err := g.m.command("seek", strconv.FormatFloat(sec, 'f', 3, 64), "absolute+keyframes"); err != nil {
		return previews.Frame{}, err
	}
	if err := waitRestart(ctx, g.m, previewGrabTimeout); err != nil {
		return previews.Frame{}, err
	}
	at, err := previewFloat(g.m, "time-pos")
	if err != nil {
		return previews.Frame{}, err
	}
	v, err := g.m.commandResult("screenshot-raw", "video", "bgr0")
	if err != nil {
		return previews.Frame{}, err
	}
	img, err := previewImage(v)
	if err != nil {
		return previews.Frame{}, err
	}
	return previews.Frame{Image: img, At: at, Gamma: g.gamma, Primaries: g.primaries}, nil
}

// Close frees the decoder and its connection, once.
func (g *previewGrabber) Close() {
	g.once.Do(g.m.destroy)
}
