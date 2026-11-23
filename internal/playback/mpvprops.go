package playback

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Pure helpers for engines that drive libmpv by property name (the iOS
// engine, ADR-0055). They hold the rules the desktop player has in
// internal/player (track and caption choice, subtitle styling, mapping mpv's
// track and chapter lists), with no cgo, so they build and test everywhere.

// Seconds formats a number the way mpv parses it (LC_NUMERIC is "C").
func Seconds(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// Number reads a number mpv sent as a double or an int64.
func Number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	}
	return 0
}

// YesNo is mpv's flag text.
func YesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// TrackProps are the mpv properties that pick a new file's tracks from o,
// as the desktop does (found by trying mpv 0.41 on files with forced and
// default-flagged subtitles). systemCaptions is the OS's captions
// preference, read for Captions "system".
func TrackProps(o LoadOptions, systemCaptions bool, fonts map[string]string) [][2]string {
	captions := o.Captions == "on" || (o.Captions != "off" && systemCaptions)
	props := [][2]string{
		{"aid", "auto"}, {"sid", "auto"},
		{"alang", strings.Join(o.AudioLanguages, ",")},
		// Off: no language and no fallback leaves forced subtitles only.
		{"slang", ""}, {"subs-fallback", "no"}, {"subs-fallback-forced", "yes"},
		// A second track picked for the last file means nothing in this one.
		{"secondary-sid", "no"},
	}
	if captions {
		props[3][1] = o.SubtitleLanguage
		props[4][1], props[5][1] = "yes", "no"
	}
	if o.SubtitleStyle != nil {
		props = append(props, StyleProps(*o.SubtitleStyle, fonts)...)
	} else if scale, ok := SubtitleScales[o.SubtitleSize]; ok {
		props = append(props, [2]string{"sub-scale", Seconds(scale)})
	}
	// Off is a hidden subtitle in a new file, never a deselect: mpv 0.41
	// refresh-seeks on sid=no, which stalls a streamed file (see
	// HideMainSubtitle).
	props = append(props, [2]string{"sub-visibility", "yes"})
	return props
}

// HideMainSubtitle returns tracks with no main subtitle track selected: while
// sub-visibility hides it, the frontend has to read the subtitles as off even
// though sid still names the track it is one property away from showing.
func HideMainSubtitle(tracks []Track) []Track {
	out := append([]Track{}, tracks...)
	for i := range out {
		if out[i].Type == "sub" && out[i].Selected && !out[i].Secondary {
			out[i].Selected = false
		}
	}
	return out
}

// IOSFonts are the faces iOS has for each SubtitleStyle.Font.
var IOSFonts = map[string]string{"sans": "Helvetica Neue", "serif": "Georgia", "mono": "Menlo"}

// StyleProps are the mpv properties that draw st, set in this order.
func StyleProps(st SubtitleStyle, fonts map[string]string) [][2]string {
	override := "scale"
	if st.Override {
		override = "force"
	}
	props := [][2]string{
		{"sub-font", fonts[st.Font]},
		{"sub-scale", Seconds(float64(st.Size) / 100)},
		{"sub-color", st.Color},
		{"sub-bold", YesNo(st.Bold)},
		{"sub-pos", strconv.Itoa(100 - st.Lift)},
		{"sub-ass-override", override},
	}
	switch st.Edge {
	case "none":
		props = append(props, [2]string{"sub-border-style", "outline-and-shadow"},
			[2]string{"sub-outline-size", "0"}, [2]string{"sub-shadow-offset", "0"})
	case "outline":
		props = append(props, [2]string{"sub-border-style", "outline-and-shadow"},
			[2]string{"sub-outline-size", "2.6"}, [2]string{"sub-outline-color", "#FF000000"},
			[2]string{"sub-shadow-offset", "0"})
	case "shadow":
		props = append(props, [2]string{"sub-border-style", "outline-and-shadow"},
			[2]string{"sub-outline-size", "0.6"}, [2]string{"sub-outline-color", "#99000000"},
			[2]string{"sub-shadow-offset", "2"}, [2]string{"sub-shadow-color", "#B0000000"})
	case "box":
		props = append(props, [2]string{"sub-border-style", "background-box"},
			[2]string{"sub-outline-size", "4"}, [2]string{"sub-shadow-offset", "0"},
			[2]string{"sub-back-color", fmt.Sprintf("#%02X000000", st.Backdrop*255/100)})
	}
	return props
}

// TracksFrom maps mpv's track-list.
func TracksFrom(v any) []Track {
	list, _ := v.([]any)
	out := make([]Track, 0, len(list))
	for _, item := range list {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		str := func(k string) string { s, _ := m[k].(string); return s }
		b := func(k string) bool { v, _ := m[k].(bool); return v }
		_, ordered := m["main-selection"]
		second := b("selected") && ordered && Number(m["main-selection"]) == 1 && str("type") == "sub"
		out = append(out, Track{
			ID: int(Number(m["id"])), Type: str("type"), Title: str("title"), Lang: str("lang"),
			Codec: str("codec"), Default: b("default"), Selected: b("selected") && !second, Secondary: second,
			External: b("external"), Forced: b("forced"), HearingImpaired: b("hearing-impaired"),
			Channels: int(Number(m["demux-channel-count"])),
			Width:    int(Number(m["demux-w"])), Height: int(Number(m["demux-h"])),
		})
	}
	return out
}

// ChaptersFrom maps mpv's chapter-list.
func ChaptersFrom(v any) []Chapter {
	list, _ := v.([]any)
	out := make([]Chapter, 0, len(list))
	for _, item := range list {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		title, _ := m["title"].(string)
		out = append(out, Chapter{Title: title, Time: Number(m["time"])})
	}
	return out
}

// SubtitleSizeName names a sub-scale, or "" for one no size has.
func SubtitleSizeName(scale float64) string {
	for size, s := range SubtitleScales {
		if math.Abs(scale-s) < 0.001 {
			return size
		}
	}
	return ""
}

// ImageSubtitle reports whether a subtitle codec is pictures (Blu-ray, DVD),
// which have no text to draw as the second line.
func ImageSubtitle(codec string) bool {
	switch codec {
	case "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "dvb_teletext", "xsub":
		return true
	}
	return false
}

var (
	expiredLog = regexp.MustCompile(`HTTP error (401|403|404|410)\b`)
	urlText    = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://\S+`)
)

// ExpiredLog reports whether an FFmpeg log line says the server refused the
// link: how an expired debrid link shows.
func ExpiredLog(text string) bool { return expiredLog.MatchString(text) }

// RedactURLs removes URLs from mpv's log messages: stream URLs carry debrid
// keys.
func RedactURLs(s string) string { return urlText.ReplaceAllString(s, "<url>") }

// MaxSubtitleBytes caps a subtitle file.
const MaxSubtitleBytes = 16 << 20

// SubtitleWait caps one download.
const SubtitleWait = 30 * time.Second

// DownloadSubtitle GETs a subtitle file, unpacking it if gzipped. Its errors
// name no URL. Peli downloads it, not mpv: mpv would send the stream's
// headers to the subtitle server too.
func DownloadSubtitle(ctx context.Context, client *http.Client, userAgent string, u *url.URL) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, SubtitleWait)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, ErrInvalid
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
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

// SubtitleExt is the URL's extension if it's a subtitle format mpv reads,
// or "".
func SubtitleExt(u *url.URL) string {
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
