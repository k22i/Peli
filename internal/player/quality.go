//go:build !ios

package player

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
)

// The shaders a Quality may load (SOURCES.txt says where each is from; all
// MIT, listed by tools/notices). mpv takes them as files, so they are
// written to the user's cache once per version of the app.
//
//go:embed shaders/*.glsl shaders/anime4k/*.glsl
var shaderFiles embed.FS

// anime4kModeA is Anime4K's "Mode A (Fast)" chain for 1080p and below, in
// its order.
var anime4kModeA = []string{
	"Anime4K_Clamp_Highlights.glsl", "Anime4K_Restore_CNN_M.glsl", "Anime4K_Upscale_CNN_x2_M.glsl",
	"Anime4K_AutoDownscalePre_x2.glsl", "Anime4K_AutoDownscalePre_x4.glsl", "Anime4K_Upscale_CNN_x2_S.glsl",
}

// qualityProps are the mpv properties for q but the shaders (shadersFor):
// the scalers and debanding, motion smoothing, deinterlacing, then tone
// mapping (tone-mapping and target-peak come last: showHDR sets just those
// two). iOS takes playback's scaling and tone properties and leaves motion
// smoothing, deinterlacing and the shaders out.
func qualityProps(q store.Quality, hdrOut bool) [][2]string {
	props := playback.ScalingProps(q)
	if q.MotionSmoothing {
		props = append(props, [2]string{"video-sync", "display-resample"},
			[2]string{"interpolation", "yes"}, [2]string{"tscale", "oversample"})
	} else {
		props = append(props, [2]string{"video-sync", "audio"}, [2]string{"interpolation", "no"})
	}
	deint := map[string]string{"auto": "auto", "on": "yes", "off": "no"}[q.Deinterlace]
	props = append(props, [2]string{"deinterlace", deint})
	return append(props, playback.ToneProps(q, hdrOut)...)
}

var (
	shadersOnce sync.Once
	shaderDir   string
	shaderErr   error
)

// shaders writes the embedded shaders to the cache, in a folder named by
// their hash (a new app version's shaders never mix with an old one's),
// and returns it.
func shaders() (string, error) {
	shadersOnce.Do(func() {
		h := sha256.New()
		_ = fs.WalkDir(shaderFiles, "shaders", func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				b, _ := shaderFiles.ReadFile(p)
				h.Write([]byte(p))
				h.Write(b)
			}
			return nil
		})
		base, err := os.UserCacheDir()
		if err != nil {
			shaderErr = err
			return
		}
		dir := filepath.Join(base, "Peli", "shaders", hex.EncodeToString(h.Sum(nil))[:12])
		shaderErr = fs.WalkDir(shaderFiles, "shaders", func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			out := filepath.Join(dir, strings.TrimPrefix(p, "shaders"))
			if d.IsDir() {
				return os.MkdirAll(out, 0o755)
			}
			b, err := shaderFiles.ReadFile(p)
			if err != nil {
				return err
			}
			return os.WriteFile(out, b, 0o644)
		})
		shaderDir = dir
	})
	return shaderDir, shaderErr
}

// casAt returns the path of AMD's CAS at strength tenths, written on first
// use. As shipped it only runs on video shown at its own size; here it runs
// unless the video is downscaled, so it sharpens before an upscale, as its
// notes suggest.
func casAt(dir string, tenths int) (string, error) {
	out := filepath.Join(dir, fmt.Sprintf("cas-%d.glsl", tenths))
	if _, err := os.Stat(out); err == nil {
		return out, nil
	}
	b, err := shaderFiles.ReadFile("shaders/cas.glsl")
	if err != nil {
		return "", err
	}
	src := strings.ReplaceAll(string(b),
		"//!WHEN OUTPUT.w OUTPUT.h * LUMA.w LUMA.h * / 1.0 > ! OUTPUT.w OUTPUT.h * LUMA.w LUMA.h * / 1.0 < ! *",
		"//!WHEN OUTPUT.w OUTPUT.h * LUMA.w LUMA.h * / 1.0 < !")
	src = strings.Replace(src, "#define SHARPENING 0.0", fmt.Sprintf("#define SHARPENING %.1f", float64(tenths)/10), 1)
	if err := os.WriteFile(out, []byte(src), 0o644); err != nil {
		return "", err
	}
	return out, nil
}

// shadersFor is mpv's glsl-shaders for q: CAS first (on the source), then
// the upscaler (it runs only when the video is smaller than the window).
func shadersFor(q store.Quality) []string {
	if q.Sharpen == 0 && q.Upscaler == "off" {
		return []string{}
	}
	dir, err := shaders()
	if err != nil {
		slog.Warn("player: shaders not written", "error", err)
		return []string{}
	}
	var list []string
	if q.Sharpen > 0 {
		if p, err := casAt(dir, q.Sharpen); err == nil {
			list = append(list, p)
		} else {
			slog.Warn("player: sharpening shader not written", "error", err)
		}
	}
	switch q.Upscaler {
	case "fsr":
		list = append(list, filepath.Join(dir, "fsr.glsl"))
	case "anime4k":
		for _, f := range anime4kModeA {
			list = append(list, filepath.Join(dir, "anime4k", f))
		}
	}
	return list
}

// qualityFor is the quality a file plays with: the one opts names, else
// the title's own, else this device's.
func (s *Service) qualityFor(opts LoadOptions) store.Quality {
	if opts.Quality != nil {
		return *opts.Quality
	}
	title, _ := s.adjustmentsFor(opts)
	return playback.QualityOf(nil, title, s.thisDevice())
}

// applyQuality sets q on the session: the properties, the shaders and the
// host's draw loop for motion smoothing.
func (s *Service) applyQuality(ses *session, q store.Quality) error {
	s.mu.Lock()
	s.quality = q
	hdr := s.state.HDR
	s.mu.Unlock()
	for _, p := range qualityProps(q, hdr) {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			return fmt.Errorf("%s: %w", p[0], err)
		}
	}
	if err := ses.m.setStringList("glsl-shaders", shadersFor(q)); err != nil {
		return fmt.Errorf("glsl-shaders: %w", err)
	}
	fps := ses.host.smooth(q.MotionSmoothing)
	override := "0" // mpv's own guess
	if q.MotionSmoothing && fps > 0 {
		override = strconv.FormatFloat(fps, 'f', 3, 64)
	}
	if err := ses.m.setProperty("display-fps-override", override); err != nil {
		slog.Warn("player: display fps not set", "error", err)
	}
	return nil
}

// SetQuality renders the picture with quality from now on: the Picture &
// sound sheet's Quality tab calls it.
func (s *Service) SetQuality(quality store.Quality) error {
	if !quality.Valid() {
		return ErrInvalid
	}
	ses := s.current()
	if ses == nil {
		return ErrNotPlaying
	}
	return s.applyQuality(ses, quality)
}
