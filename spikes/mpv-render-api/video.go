package main

/*
#include "video.h"
*/
import "C"

import (
	"math"
	"time"
)

// frameStats is a Go copy of the render code's fstats (video.h).
type frameStats struct {
	Renders, Frames int64
	Intervals       []float64 // ms between new-frame renders
	CPU, GPU        []float64 // ms per render call
	W, H            int
	Readback        map[string]any
	Note            string
}

// readFrameStats copies the render stats; reset starts a new window.
func readFrameStats(reset bool) frameStats {
	var fs C.fstats
	C.spike_video_stats(&fs, boolInt(reset))
	out := frameStats{
		Renders: int64(fs.renders), Frames: int64(fs.frames),
		W: int(fs.w), H: int(fs.h), Note: C.GoString(&fs.note[0]),
	}
	for i := 0; i < int(fs.n_interval); i++ {
		out.Intervals = append(out.Intervals, float64(fs.interval_ms[i]))
	}
	for i := 0; i < int(fs.n_cpu); i++ {
		out.CPU = append(out.CPU, float64(fs.cpu_ms[i]))
	}
	for i := 0; i < int(fs.n_gpu); i++ {
		out.GPU = append(out.GPU, float64(fs.gpu_ms[i]))
	}
	if fs.readback_done != 0 {
		out.Readback = map[string]any{
			"max": round(float64(fs.rb_max)), "mean": round(float64(fs.rb_mean)),
			"overSdrWhite": round(float64(fs.rb_over_white)),
		}
	}
	return out
}

func boolInt(b bool) C.int {
	if b {
		return 1
	}
	return 0
}

// waitVideoReady waits for the render context: mpv must not start video
// before it exists, or it falls back to a VO with its own window.
func waitVideoReady(timeout time.Duration) int {
	deadline := time.Now().Add(timeout)
	for {
		if r := int(C.spike_video_ready()); r != 0 || time.Now().After(deadline) {
			return r
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func requestReadback() { C.spike_video_readback() }

// pacing summarises frame intervals against the video's frame duration:
// how far they spread, and how many frames were shown late (> 1.5x).
func pacing(intervals []float64, fps float64) map[string]any {
	if len(intervals) == 0 {
		return map[string]any{"n": 0}
	}
	mean := 0.0
	for _, x := range intervals {
		mean += x
	}
	mean /= float64(len(intervals))
	sd := 0.0
	long := 0
	expected := 0.0
	if fps > 0 {
		expected = 1000 / fps
	}
	for _, x := range intervals {
		sd += (x - mean) * (x - mean)
		if expected > 0 && x > 1.5*expected {
			long++
		}
	}
	return map[string]any{
		"intervalMs": summarize(intervals), "stddevMs": round(math.Sqrt(sd / float64(len(intervals)))),
		"expectedMs": round(expected), "late": long, "lateShare": round(float64(long) / float64(len(intervals))),
	}
}
