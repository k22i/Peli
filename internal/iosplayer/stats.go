//go:build ios

package iosplayer

import (
	"log/slog"
	"syscall"
	"time"
)

// statsEvery is how often a playing session logs its frame rate, dropped
// frames and the process's CPU use. Device runs read these from the log
// (ios/README.md, "On a real device"); there is no on-screen stats view on
// iOS.
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
