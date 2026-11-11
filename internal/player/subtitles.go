package player

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"time"
)

// ErrSubtitles means an addon's subtitles couldn't be added: the download
// failed, or mpv couldn't read the file.
var ErrSubtitles = errors.New("player: subtitles couldn't be loaded")

// CodeSubtitles is ErrSubtitles' code for the frontend.
const CodeSubtitles = "subtitles"

const (
	// MaxSubtitleBytes caps a subtitle file. A feature film's SRT is under
	// 200 KB; ASS with styling a few MB.
	MaxSubtitleBytes = 16 << 20
	// subtitleWait caps one download.
	subtitleWait = 30 * time.Second
)

// Subtitle is a subtitle file from an addon (#63), as AddSubtitle takes it.
type Subtitle struct {
	URL string `json:"url"`
	// Lang is an ISO 639 code ("en", "por"), or "" if the addon's isn't one.
	Lang string `json:"lang"`
	// Title names it in the track list, such as the addon's name.
	Title string `json:"title"`
	// Secondary adds it as the second line (dual subtitles) and leaves the
	// main subtitles as they are.
	Secondary bool `json:"secondary"`
}

// AddSubtitle downloads sub and adds it to the file playing as an external
// track, and shows it (as the second line when sub.Secondary). It returns
// the track's id in State.Tracks. Loading another file drops it, as mpv
// drops every external track then.
//
// Peli downloads it, not mpv: mpv would send the stream's headers (a
// debrid addon's, say) to the subtitle server too.
func (s *Service) AddSubtitle(ctx context.Context, sub Subtitle) (int, error) {
	u, err := url.Parse(sub.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		!languageCode.MatchString(sub.Lang) {
		return 0, ErrInvalid
	}
	if s.current() == nil {
		return 0, ErrNotPlaying
	}
	data, err := s.download(ctx, u)
	if err != nil {
		return 0, err
	}

	s.ops.Lock()
	defer s.ops.Unlock()
	ses := s.current()
	if ses == nil {
		return 0, ErrNotPlaying
	}
	// mpv reads the file when it's added, but an ASS file's fonts and a
	// sub-reload read it again, so it stays until the session closes.
	if ses.subDir == "" {
		dir, err := os.MkdirTemp("", "peli-subtitles-")
		if err != nil {
			return 0, fmt.Errorf("%w: %w", ErrSubtitles, err)
		}
		ses.subDir = dir
	}
	// The URL's extension, when it has one, helps mpv tell the format.
	f, err := os.CreateTemp(ses.subDir, "*"+subtitleExt(u))
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrSubtitles, err)
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrSubtitles, err)
	}
	// "auto" adds it without selecting it: the second line is picked below.
	flags := "select"
	if sub.Secondary {
		flags = "auto"
	}
	if err := ses.m.command("sub-add", f.Name(), flags, sub.Title, sub.Lang); err != nil {
		if errors.Is(err, errDestroyed) {
			return 0, ErrNotPlaying
		}
		return 0, fmt.Errorf("%w: %w", ErrSubtitles, err)
	}
	id, err := addedTrack(ses.m, f.Name())
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrSubtitles, err)
	}
	if sub.Secondary {
		if err := ses.m.setProperty("secondary-sid", strconv.Itoa(id)); err != nil {
			return 0, fmt.Errorf("%w: %w", ErrSubtitles, err)
		}
	}
	return id, nil
}

// download GETs a subtitle file, unpacking it if it's gzipped (some addons
// serve .srt.gz). Its errors name no URL.
func (s *Service) download(ctx context.Context, u *url.URL) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, subtitleWait)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, ErrInvalid
	}
	req.Header.Set("User-Agent", s.userAgent)
	resp, err := s.http.Do(req)
	if err != nil {
		if ctx.Err() != nil && errors.Is(context.Cause(ctx), context.Canceled) {
			return nil, context.Canceled
		}
		return nil, fmt.Errorf("%w: unreachable", ErrSubtitles)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrSubtitles, resp.StatusCode)
	}
	body := bufio.NewReader(resp.Body)
	var r io.Reader = body
	if magic, _ := body.Peek(2); bytes.Equal(magic, []byte{0x1f, 0x8b}) {
		gz, err := gzip.NewReader(body)
		if err != nil {
			return nil, fmt.Errorf("%w: bad gzip", ErrSubtitles)
		}
		defer gz.Close()
		r = gz
	}
	data, err := io.ReadAll(io.LimitReader(r, MaxSubtitleBytes+1))
	switch {
	case err != nil:
		return nil, fmt.Errorf("%w: download cut short", ErrSubtitles)
	case len(data) > MaxSubtitleBytes:
		return nil, fmt.Errorf("%w: too large", ErrSubtitles)
	case len(data) == 0:
		return nil, fmt.Errorf("%w: empty", ErrSubtitles)
	}
	return data, nil
}

// subtitleExt is the URL's extension if it's a subtitle format mpv reads,
// or "".
func subtitleExt(u *url.URL) string {
	ext := path.Ext(path.Clean(u.Path))
	if ext == ".gz" {
		ext = path.Ext(u.Path[:len(u.Path)-len(ext)])
	}
	switch ext {
	case ".srt", ".vtt", ".ass", ".ssa", ".sub", ".smi":
		return ext
	}
	return ""
}

// addedTrack finds the id of the external track mpv made from file: the
// last in the list, as sub-add appends.
func addedTrack(m *mpv, file string) (int, error) {
	count, err := m.getString("track-list/count")
	if err != nil {
		return 0, err
	}
	n, _ := strconv.Atoi(count)
	for i := n - 1; i >= 0; i-- {
		prefix := "track-list/" + strconv.Itoa(i) + "/"
		if name, _ := m.getString(prefix + "external-filename"); name != file {
			continue
		}
		id, err := m.getString(prefix + "id")
		if err != nil {
			return 0, err
		}
		return strconv.Atoi(id)
	}
	return 0, errors.New("added track not in the track list")
}

// SystemCaptions reports whether the OS asks for captions (#62): what
// LoadOptions' "system" follows. The player screen asks, to know whether to
// add an addon's subtitles when the file has none in the profile's
// language.
func (s *Service) SystemCaptions() bool {
	return systemCaptions()
}
