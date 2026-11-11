package player

import (
	"errors"
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// Screenshots are PNGs in ~/Pictures/Sinag. Our FFmpeg has no encoders
// (#92), so mpv's screenshot command can't write them: screenshot-raw hands
// Go the frame, which image/png encodes.

// screenshotDir is where screenshots go; a variable so tests can move it.
var screenshotDir = func() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Pictures", "Sinag"), nil
}

// Screenshot saves the frame showing as a PNG, at the video's own size,
// with the subtitles mpv draws on it or without, and returns its path. The
// second line of subtitles is the screen's, so it isn't in it.
func (s *Service) Screenshot(subtitles bool) (string, error) {
	ses := s.current()
	if ses == nil {
		return "", ErrNotPlaying
	}
	flags := "video"
	if subtitles {
		flags = "subtitles"
	}
	v, err := ses.m.commandResult("screenshot-raw", flags, "bgr0")
	if err != nil {
		return "", notPlaying(err)
	}
	img, err := rawImage(v)
	if err != nil {
		return "", err
	}
	dir, err := screenshotDir()
	if err != nil {
		return "", fmt.Errorf("player: no folder for screenshots: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("player: screenshot folder: %w", err)
	}
	s.mu.Lock()
	name := screenshotName(s.nowPlaying, s.state.Position)
	s.mu.Unlock()
	return writePNG(dir, name, img)
}

// rawImage turns screenshot-raw's bgr0 frame into an opaque image.
func rawImage(v any) (*image.NRGBA, error) {
	m, _ := v.(map[string]any)
	data, _ := m["data"].([]byte)
	w, _ := m["w"].(int64)
	h, _ := m["h"].(int64)
	stride, _ := m["stride"].(int64)
	if w <= 0 || h <= 0 || stride < w*4 || int64(len(data)) < stride*h {
		return nil, errors.New("player: no frame to take")
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

// screenshotName names a screenshot by what plays and where: "Severance –
// S1:E2 Half Loop 0.12.34". Characters a file name can't hold on macOS or
// Windows become spaces.
func screenshotName(playing NowPlaying, position float64) string {
	parts := []string{}
	for _, part := range []string{playing.Title, playing.Subtitle} {
		if part = cleanName(part); part != "" {
			parts = append(parts, part)
		}
	}
	title := strings.Join(parts, " – ")
	if title == "" {
		title = "Sinag"
	}
	if r := []rune(title); len(r) > 120 {
		title = strings.TrimSpace(string(r[:120]))
	}
	t := int(math.Max(0, position))
	return fmt.Sprintf("%s %d.%02d.%02d", title, t/3600, t/60%60, t%60)
}

func cleanName(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	// Windows drops trailing dots and spaces.
	return strings.Trim(strings.Join(strings.Fields(s), " "), ". ")
}

// writePNG writes img as name.png in dir, or name 2.png and on when that's
// taken, through a temporary file so a half-written one never shows.
func writePNG(dir, name string, img image.Image) (string, error) {
	tmp, err := os.CreateTemp(dir, ".sinag-shot-*.png")
	if err != nil {
		return "", fmt.Errorf("player: screenshot: %w", err)
	}
	defer os.Remove(tmp.Name())
	// Speed over size: a 4K frame takes a fraction of a second, not seconds.
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(tmp, img); err != nil {
		tmp.Close()
		return "", fmt.Errorf("player: screenshot: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("player: screenshot: %w", err)
	}
	for n := 1; n < 1000; n++ {
		path := filepath.Join(dir, name+".png")
		if n > 1 {
			path = filepath.Join(dir, fmt.Sprintf("%s %d.png", name, n))
		}
		// A hard link fails if the name is taken, where a rename would
		// replace it.
		if err := os.Link(tmp.Name(), path); err == nil {
			return path, nil
		} else if !errors.Is(err, os.ErrExist) {
			return "", fmt.Errorf("player: screenshot: %w", err)
		}
	}
	return "", errors.New("player: screenshot: no free name")
}

// ShowScreenshot shows a screenshot Screenshot saved in the OS's file
// manager, selected: Finder, File Explorer. Only paths in the screenshots
// folder are shown.
func (s *Service) ShowScreenshot(path string) error {
	dir, err := screenshotDir()
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(dir, filepath.Clean(path))
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) || filepath.Dir(rel) != "." {
		return ErrInvalid
	}
	if _, err := os.Stat(path); err != nil {
		return ErrInvalid
	}
	return reveal(path)
}
