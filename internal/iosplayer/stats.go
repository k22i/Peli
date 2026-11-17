//go:build ios

package iosplayer

import (
	"log/slog"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/k22i/Peli/internal/playback"
)

// statsEvery is how often a playing session logs its frame rate, dropped
// frames and the process's CPU use. Device runs read these from the log
// (ios/README.md, "On a real device"); the player's More menu shows Stats
// on screen (#130).
const statsEvery = 15 * time.Second

// logStats logs one "iosplayer: stats" line per statsEvery while ses is the
// current session and playing. cpu is the whole process (decoder, the 10-bit
// to 8-bit filter, GL, Go and the webview's host side), in percent of one
// core over the last interval, so it can pass 100.
func (e *Engine) logStats(ses *session) {
	tick := time.NewTicker(statsEvery)
	defer tick.Stop()
	lastCPU, lastAt := cpuTime(), time.Now()
	for {
		select {
		case <-ses.done:
			return
		case <-tick.C:
		}
		if e.current() != ses {
			return
		}
		cpu, now := cpuTime(), time.Now()
		pct := 100 * float64(cpu-lastCPU) / float64(now.Sub(lastAt))
		lastCPU, lastAt = cpu, now
		if paused, _ := ses.m.getString("pause"); paused == "yes" {
			continue
		}
		vals := map[string]string{}
		for _, k := range []string{"hwdec-current", "video-params/pixelformat", "width", "height",
			"container-fps", "estimated-vf-fps", "estimated-display-fps",
			"frame-drop-count", "decoder-frame-drop-count", "vo-delayed-frame-count",
			"cache-buffering-state", "demuxer-cache-duration"} {
			vals[k], _ = ses.m.getString(k)
		}
		slog.Info("iosplayer: stats", "cpu", int(pct+0.5), "mode", ses.hw, "props", vals)
	}
}

// cpuTime is the process's user + system CPU time so far.
func cpuTime() time.Duration {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

// Stats reads the stats overlay's numbers from the session, as the desktop
// player does (internal/player/stats.go), for the touch player's More menu.
func (e *Engine) Stats() (playback.Stats, error) {
	ses := e.current()
	if ses == nil {
		return playback.Stats{}, playback.ErrNotPlaying
	}
	str := func(name string) string {
		v, err := ses.m.getString(name)
		if err != nil {
			return ""
		}
		return v
	}
	num := func(name string) float64 {
		f, err := strconv.ParseFloat(str(name), 64)
		if err != nil {
			return 0
		}
		return f
	}
	st := e.Snapshot()
	out := playback.Stats{
		VideoCodec:    strings.TrimSpace(str("current-tracks/video/codec")),
		Width:         int(num("video-params/w")),
		Height:        int(num("video-params/h")),
		FPS:           num("estimated-vf-fps"),
		PixelFormat:   str("video-params/hw-pixelformat"),
		Gamma:         str("video-params/gamma"),
		Primaries:     str("video-params/primaries"),
		ColorMatrix:   str("video-params/colormatrix"),
		OutputWidth:   int(num("video-out-params/dw")),
		OutputHeight:  int(num("video-out-params/dh")),
		HWDec:         st.HWDec,
		DroppedFrames: int64(num("frame-drop-count")),
		DecoderDrops:  int64(num("decoder-frame-drop-count")),
		AudioCodec:    str("current-tracks/audio/codec"),
		AudioChannels: int(num("audio-params/channel-count")),
		VideoBitrate:  num("video-bitrate"),
		AudioBitrate:  num("audio-bitrate"),
		CacheSeconds:  st.Buffered,
		CacheSpeed:    num("cache-speed"),
		Renderer:      str("current-vo"),
		GPUContext:    str("current-gpu-context"),
		DisplayFPS:    num("display-fps"),
	}
	if out.FPS == 0 {
		out.FPS = num("container-fps")
	}
	if out.PixelFormat == "" {
		out.PixelFormat = str("video-params/pixelformat")
	}
	return out, nil
}
