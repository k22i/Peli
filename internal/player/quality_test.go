package player

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

func propMap(props [][2]string) map[string]string {
	m := map[string]string{}
	for _, p := range props {
		m[p[0]] = p[1]
	}
	return m
}

func TestQualityProps(t *testing.T) {
	def := propMap(qualityProps(store.DefaultQuality(), false))
	if def["scale"] != "lanczos" || def["deband"] != "no" || def["interpolation"] != "no" ||
		def["video-sync"] != "audio" || def["deinterlace"] != "auto" || def["tone-mapping"] != "auto" ||
		def["target-peak"] != "auto" {
		t.Errorf("default: %v", def)
	}
	q := store.Quality{Scaling: "high", Deband: "medium", Upscaler: "off", MotionSmoothing: true,
		Deinterlace: "on", ToneMapping: "hable", TargetPeak: 300}
	got := propMap(qualityProps(q, false))
	if got["scale"] != "ewa_lanczossharp" || got["deband"] != "yes" || got["deband-iterations"] != "2" ||
		got["video-sync"] != "display-resample" || got["interpolation"] != "yes" || got["tscale"] != "oversample" ||
		got["deinterlace"] != "yes" || got["tone-mapping"] != "hable" || got["target-peak"] != "300" {
		t.Errorf("high, deband, smoothing, tone mapping: %v", got)
	}
	// Shown as HDR, tone mapping is mpv's.
	hdr := qualityProps(q, true)
	if last := hdr[len(hdr)-2:]; last[0] != [2]string{"tone-mapping", "auto"} || last[1] != [2]string{"target-peak", "auto"} {
		t.Errorf("HDR out: last props %v, want tone mapping and peak on auto", last)
	}
	if fast := propMap(qualityProps(store.Quality{Scaling: "fast", Deband: "off", Upscaler: "off", Deinterlace: "off", ToneMapping: "auto"}, false)); fast["scale"] != "bilinear" || fast["deinterlace"] != "no" {
		t.Errorf("fast: %v", fast)
	}
}

func TestShadersFor(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // os.UserCacheDir on macOS
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	if got := shadersFor(store.DefaultQuality()); len(got) != 0 {
		t.Errorf("default: %v, want none", got)
	}
	q := store.Quality{Scaling: "balanced", Deband: "off", Sharpen: 5, Upscaler: "anime4k", Deinterlace: "auto", ToneMapping: "auto"}
	list := shadersFor(q)
	if len(list) != 1+len(anime4kModeA) || !strings.HasSuffix(list[0], "cas-5.glsl") ||
		!strings.HasSuffix(list[len(list)-1], "Anime4K_Upscale_CNN_x2_S.glsl") {
		t.Fatalf("CAS then Anime4K: %v", list)
	}
	for _, p := range list {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s: %v", filepath.Base(p), err)
		}
	}
	cas, _ := os.ReadFile(list[0])
	if !strings.Contains(string(cas), "#define SHARPENING 0.5") ||
		!strings.Contains(string(cas), "//!WHEN OUTPUT.w OUTPUT.h * LUMA.w LUMA.h * / 1.0 < !\n") {
		t.Error("CAS isn't at 0.5, or still only runs unscaled")
	}
	if fsr := shadersFor(store.Quality{Scaling: "balanced", Deband: "off", Upscaler: "fsr", Deinterlace: "auto", ToneMapping: "auto"}); len(fsr) != 1 || filepath.Base(fsr[0]) != "fsr.glsl" {
		t.Errorf("FSR: %v", fsr)
	}
	// No shader in the build may need compute shaders: Apple's OpenGL has none.
	for _, p := range list {
		b, _ := os.ReadFile(p)
		if strings.Contains(string(b), "//!COMPUTE") {
			t.Errorf("%s has a compute pass", filepath.Base(p))
		}
	}
}

// The trimmed libmpv takes every option and shader a Quality sets.
func TestQualityAtLoadAndLive(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	q := store.Quality{Scaling: "high", Deband: "high", Sharpen: 3, Upscaler: "fsr", MotionSmoothing: true,
		Deinterlace: "on", ToneMapping: "bt.2390", TargetPeak: 200}
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Quality: &q}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { return !s.Snapshot().Loading })
	if err := s.applyQuality(s.current(), q); err != nil {
		t.Fatalf("applyQuality: %v", err)
	}
	if v, _ := s.current().m.getString("glsl-shaders"); !strings.Contains(v, "fsr.glsl") {
		t.Errorf("glsl-shaders = %q", v)
	}
	if err := s.SetQuality(store.DefaultQuality()); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.current().m.getString("interpolation"); v != "no" {
		t.Errorf("interpolation after the default = %q", v)
	}
	if err := s.SetQuality(store.Quality{Scaling: "max"}); err == nil {
		t.Error("an unknown scaling preset was taken")
	}
}
