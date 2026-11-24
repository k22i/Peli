package main

import (
	"fmt"
	"image"
	"image/color"
	"time"
)

// Thumbnailer is a second, headless mpv on the same stream as the player:
// no video output, no audio, paused. Each thumbnail is a keyframe seek
// (no decoding forward to the exact time), then screenshot-raw of the frame
// the decoder made, scaled down in the filter chain.
type Thumbnailer struct {
	m        *mpv
	Duration float64
	Gamma    string // video-params/gamma: "pq" and "hlg" need tone mapping
	Prim     string
	Codec    string
	W, H     int // source size
}

type Options struct {
	Width  int    // thumbnail width; height keeps the aspect
	Hwdec  string // "no", "auto-copy"
	Header string // http-header-fields
	Chunk  int64  // FFmpeg http request_size: 0 = open-ended requests
	Queue  string // demuxer-max-bytes
}

func openThumbnailer(url string, o Options) (*Thumbnailer, time.Duration, error) {
	start := time.Now()
	opts := [][2]string{
		{"config", "no"},
		{"terminal", "no"},
		{"vo", "null"},
		{"ao", "null"},
		{"aid", "no"},
		{"sid", "no"},
		{"pause", "yes"},
		{"keep-open", "always"},
		{"idle", "yes"},
		{"hr-seek", "no"},
		{"hwdec", o.Hwdec},
		// Skipping the deblocking filter halves HEVC decode time; a
		// 320-pixel thumbnail doesn't show it.
		{"vd-lavc-skiploopfilter", "all"},
		{"vd-lavc-threads", "4"},
		// Read only what a keyframe needs: no read-ahead, no back buffer.
		{"cache", "no"},
		{"demuxer-readahead-secs", "0"},
		{"demuxer-max-bytes", o.Queue},
		{"demuxer-max-back-bytes", "0"},
		{"vf", fmt.Sprintf("scale=w=%d:h=-2:flags=fast_bilinear", o.Width)},
	}
	if o.Chunk > 0 {
		// Bounded Range requests: a seek doesn't leave a request streaming
		// the rest of the file into the socket.
		opts = append(opts, [2]string{"stream-lavf-o", fmt.Sprintf("request_size=%d", o.Chunk)})
	}
	if o.Header != "" {
		opts = append(opts, [2]string{"http-header-fields", o.Header})
	}
	m, err := newMpv(opts)
	if err != nil {
		return nil, 0, err
	}
	if _, err := m.command("loadfile", url); err != nil {
		m.destroy()
		return nil, 0, err
	}
	if err := m.waitFor(evPlaybackRestart, 60*time.Second); err != nil {
		m.destroy()
		return nil, 0, fmt.Errorf("open: %w", err)
	}
	t := &Thumbnailer{m: m}
	fmt.Sscan(m.getString("duration"), &t.Duration)
	t.Gamma = m.getString("video-params/gamma")
	t.Prim = m.getString("video-params/primaries")
	t.Codec = m.getString("video-codec")
	fmt.Sscan(m.getString("video-params/w"), &t.W)
	fmt.Sscan(m.getString("video-params/h"), &t.H)
	return t, time.Since(start), nil
}

func (t *Thumbnailer) Close() { t.m.destroy() }

// At takes the keyframe at or before sec. got is the frame's own time.
func (t *Thumbnailer) At(sec float64) (img *image.RGBA, got float64, err error) {
	if _, err := t.m.command("seek", fmt.Sprintf("%.3f", sec), "absolute+keyframes"); err != nil {
		return nil, 0, err
	}
	if err := t.m.waitFor(evPlaybackRestart, 30*time.Second); err != nil {
		return nil, 0, err
	}
	fmt.Sscan(t.m.getString("time-pos"), &got)
	v, err := t.m.command("screenshot-raw", "video", "bgr0")
	if err != nil {
		return nil, got, err
	}
	return rawImage(v), got, nil
}

// rawImage turns screenshot-raw's bgr0 map into an RGBA image.
func rawImage(v any) *image.RGBA {
	m, _ := v.(map[string]any)
	w, _ := m["w"].(int64)
	h, _ := m["h"].(int64)
	stride, _ := m["stride"].(int64)
	data, _ := m["data"].([]byte)
	img := image.NewRGBA(image.Rect(0, 0, int(w), int(h)))
	for y := 0; y < int(h); y++ {
		row := data[y*int(stride):]
		for x := 0; x < int(w); x++ {
			p := row[x*4:]
			img.SetRGBA(x, y, color.RGBA{p[2], p[1], p[0], 255})
		}
	}
	return img
}
