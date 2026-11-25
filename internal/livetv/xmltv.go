package livetv

import (
	"bufio"
	"compress/gzip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ErrNotGuide is what ParseGuide returns for input that isn't XMLTV.
var ErrNotGuide = errors.New("livetv: not an XMLTV guide")

// Guide is what ParseGuide keeps.
type Guide struct {
	// Programmes by our Channel.ID, each list sorted by Start.
	Programmes map[string][]Programme
	// GuideChannels is how many <channel> elements the file had; Matched how
	// many of our channels got at least one guide channel.
	GuideChannels int
	Matched       int
}

// GuideReader returns r, unzipped if it starts with gzip's magic bytes. Guide
// hosts hand out both, often with no Content-Encoding to go by.
func GuideReader(r io.Reader) (io.Reader, error) {
	br := bufio.NewReader(r)
	head, err := br.Peek(2)
	if err == nil && head[0] == 0x1f && head[1] == 0x8b {
		zr, err := gzip.NewReader(br)
		if err != nil {
			return nil, fmt.Errorf("livetv: unzipping the guide: %w", err)
		}
		return zr, nil
	}
	// A shorter input than two bytes isn't gzipped; the parser says whether
	// it's a guide at all.
	return br, nil
}

// xmlChannel is one <channel> element.
type xmlChannel struct {
	ID    string   `xml:"id,attr"`
	Names []string `xml:"display-name"`
}

// xmlProgramme is the part of a <programme> element ParseGuide keeps. Every
// field is a list because XMLTV allows repeats, usually per language.
type xmlProgramme struct {
	Titles     []string        `xml:"title"`
	SubTitles  []string        `xml:"sub-title"`
	Descs      []string        `xml:"desc"`
	Categories []string        `xml:"category"`
	EpisodeNum []xmlEpisodeNum `xml:"episode-num"`
	Icons      []xmlIcon       `xml:"icon"`
}

type xmlEpisodeNum struct {
	System string `xml:"system,attr"`
	Value  string `xml:",chardata"`
}

type xmlIcon struct {
	Src string `xml:"src,attr"`
}

// ParseGuide streams an XMLTV document and keeps the programmes of the
// channels m matches that overlap [from, to). The document is walked one
// element at a time: guides run to hundreds of megabytes, so nothing but the
// kept programmes is ever held.
func ParseGuide(r io.Reader, m *Matcher, from, to time.Time) (Guide, error) {
	d := xml.NewDecoder(r)
	// Guides in the wild are hand-assembled often enough that a stray
	// character shouldn't lose the whole file.
	d.Strict = false
	d.CharsetReader = charsetReader

	guide := Guide{Programmes: map[string][]Programme{}}
	fromMS, toMS := from.UnixMilli(), to.UnixMilli()

	var (
		channels   []GuideChannel
		resolved   map[string][]string
		perChannel = map[string][]Programme{}
		sawChannel bool
		sawProgram bool
	)

	if err := readGuideRoot(d); err != nil {
		return Guide{}, err
	}

walk:
	for {
		tok, err := d.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				// A cut-off document: <tv> was never closed.
				return Guide{}, fmt.Errorf("livetv: reading the guide: %w", io.ErrUnexpectedEOF)
			}
			return Guide{}, fmt.Errorf("livetv: reading the guide: %w", err)
		}
		switch tok := tok.(type) {
		case xml.StartElement:
			switch tok.Name.Local {
			case "channel":
				sawChannel = true
				var c xmlChannel
				if err := d.DecodeElement(&c, &tok); err != nil {
					return Guide{}, fmt.Errorf("livetv: reading the guide: %w", err)
				}
				names := make([]string, 0, len(c.Names))
				for _, name := range c.Names {
					if name = strings.TrimSpace(name); name != "" {
						names = append(names, name)
					}
				}
				channels = append(channels, GuideChannel{ID: strings.TrimSpace(c.ID), Names: names})
			case "programme":
				sawProgram = true
				// Every <channel> comes before the first <programme>, so
				// this is where the guide's channels can be matched once.
				if resolved == nil {
					resolved = m.Resolve(channels)
				}
				if err := readProgramme(d, tok, m, resolved, perChannel, from, to); err != nil {
					return Guide{}, err
				}
			}
		case xml.EndElement:
			// The only end tag seen here is </tv>; the rest are eaten by
			// DecodeElement.
			if tok.Name.Local == "tv" {
				break walk
			}
		}
	}

	if !sawChannel && !sawProgram {
		return Guide{}, ErrNotGuide
	}

	guide.GuideChannels = len(channels)
	// A guide channel can match several of ours and several can match the
	// same one, so what's counted is the channels, not the guide entries.
	matched := make(map[string]bool, len(resolved))
	for _, ids := range resolved {
		for _, id := range ids {
			matched[id] = true
		}
	}
	guide.Matched = len(matched)
	for id, programmes := range perChannel {
		if keep := trimGuideProgrammes(programmes, fromMS, toMS); len(keep) > 0 {
			guide.Programmes[id] = keep
		}
	}
	return guide, nil
}

// readGuideRoot walks to the document's first element and requires it to be <tv>.
func readGuideRoot(d *xml.Decoder) error {
	for {
		tok, err := d.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return ErrNotGuide
			}
			return fmt.Errorf("livetv: reading the guide: %w", err)
		}
		if start, ok := tok.(xml.StartElement); ok {
			if start.Name.Local != "tv" {
				return ErrNotGuide
			}
			return nil
		}
	}
}

// readProgramme decodes one <programme> element that starts at se, and adds a
// copy of it to perChannel for each of our channels it belongs to. Anything
// it can't place, or that falls outside the window, is skipped undecoded.
func readProgramme(d *xml.Decoder, se xml.StartElement, m *Matcher, resolved map[string][]string, perChannel map[string][]Programme, from, to time.Time) error {
	// skip drops the element's body, which is most of a guide.
	skip := func() error {
		if err := d.Skip(); err != nil {
			return fmt.Errorf("livetv: reading the guide: %w", err)
		}
		return nil
	}

	channel := attrValue(se, "channel")
	ids, ok := resolved[channel]
	if !ok {
		// No <channel> element for it: the programme still names a tvg-id.
		ids = m.ByTvgID(channel)
		resolved[channel] = ids
	}
	if len(ids) == 0 {
		return skip()
	}

	start, err := parseTime(attrValue(se, "start"))
	if err != nil {
		return skip()
	}
	var stop time.Time
	stopKnown := false
	if value := attrValue(se, "stop"); value != "" {
		if stop, err = parseTime(value); err == nil {
			stopKnown = true
		}
	}
	// A programme outside the window is dropped before it's decoded; one
	// with no usable stop is kept, since its end is still unknown.
	if stopKnown && !(stop.After(from) && start.Before(to)) {
		return skip()
	}

	var body xmlProgramme
	if err := d.DecodeElement(&body, &se); err != nil {
		return fmt.Errorf("livetv: reading the guide: %w", err)
	}

	p := Programme{
		Start:       start.UnixMilli(),
		Title:       firstValue(body.Titles),
		SubTitle:    firstValue(body.SubTitles),
		Description: firstValue(body.Descs),
		Categories:  allValues(body.Categories),
		Icon:        iconSrc(body.Icons),
		Episode:     episodeLabel(body.EpisodeNum),
	}
	if stopKnown {
		p.Stop = stop.UnixMilli()
	}
	for _, id := range ids {
		p.ChannelID = id
		perChannel[id] = append(perChannel[id], p)
	}
	return nil
}

// trimGuideProgrammes sorts a channel's programmes and drops the ones that can't
// be shown: repeats, and anything with no length inside the window.
func trimGuideProgrammes(programmes []Programme, fromMS, toMS int64) []Programme {
	sort.SliceStable(programmes, func(i, j int) bool {
		return programmes[i].Start < programmes[j].Start
	})

	kept := make([]Programme, 0, len(programmes))
	for i, p := range programmes {
		if i > 0 && p.Start == programmes[i-1].Start {
			continue
		}
		kept = append(kept, p)
	}

	for i := range kept {
		if kept[i].Stop != 0 {
			continue
		}
		// No stop given: a programme runs until the next one starts, or —
		// at the end of what the guide covers — a half hour.
		if i+1 < len(kept) && kept[i+1].Start > kept[i].Start {
			kept[i].Stop = kept[i+1].Start
		} else {
			kept[i].Stop = kept[i].Start + int64(30*time.Minute/time.Millisecond)
		}
	}

	window := kept[:0]
	for _, p := range kept {
		if p.Stop <= p.Start {
			continue
		}
		if p.Stop <= fromMS || p.Start >= toMS {
			continue
		}
		window = append(window, p)
	}
	return window
}

// attrValue is the attribute called name on se, trimmed.
func attrValue(se xml.StartElement, name string) string {
	for _, a := range se.Attr {
		if a.Name.Local == name {
			return strings.TrimSpace(a.Value)
		}
	}
	return ""
}

// firstValue is the first value that holds more than spaces, trimmed.
func firstValue(values []string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

// allValues is every value that holds more than spaces, trimmed; never nil, so
// the frontend gets a list to map over.
func allValues(values []string) []string {
	kept := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			kept = append(kept, value)
		}
	}
	return kept
}

func iconSrc(icons []xmlIcon) string {
	for _, icon := range icons {
		if src := strings.TrimSpace(icon.Src); src != "" {
			return src
		}
	}
	return ""
}

// episodeLabel prefers the machine-readable episode number, and falls back
// on the text the channel puts on screen.
func episodeLabel(values []xmlEpisodeNum) string {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value.System), "xmltv_ns") {
			if text := xmltvNS(value.Value); text != "" {
				return text
			}
		}
	}
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value.System), "onscreen") {
			return strings.TrimSpace(value.Value)
		}
	}
	return ""
}

// xmltvNS turns an xmltv_ns value ("season.episode.part", each zero-based and
// each optionally "n/total") into "S1 E3". The part is of no use to us.
func xmltvNS(value string) string {
	parts := strings.Split(value, ".")
	season, hasSeason := nsNumber(parts, 0)
	number, hasNumber := nsNumber(parts, 1)
	switch {
	case hasSeason && hasNumber:
		return fmt.Sprintf("S%d E%d", season+1, number+1)
	case hasNumber:
		return fmt.Sprintf("E%d", number+1)
	case hasSeason:
		return fmt.Sprintf("S%d", season+1)
	}
	return ""
}

// nsNumber reads the n of an "n/total" part. Anything that isn't a number
// counts as missing.
func nsNumber(parts []string, i int) (int, bool) {
	if i >= len(parts) {
		return 0, false
	}
	part := parts[i]
	if slash := strings.IndexByte(part, '/'); slash >= 0 {
		part = part[:slash]
	}
	n, err := strconv.Atoi(strings.TrimSpace(part))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// parseTime reads an XMLTV time: "YYYYMMDDhhmmss" or the shorter forms, with
// a UTC offset, "Z" or nothing after it.
func parseTime(value string) (time.Time, error) {
	s := strings.TrimSpace(value)
	digits := 0
	for digits < len(s) && s[digits] >= '0' && s[digits] <= '9' {
		digits++
	}
	var layout string
	switch digits {
	case 14:
		layout = "20060102150405"
	case 12:
		layout = "200601021504"
	case 8:
		layout = "20060102"
	default:
		return time.Time{}, errors.New("livetv: a guide time needs 8, 12 or 14 digits")
	}
	t, err := time.Parse(layout, s[:digits])
	if err != nil {
		return time.Time{}, fmt.Errorf("livetv: reading a guide time: %w", err)
	}

	zone := strings.TrimSpace(s[digits:])
	switch {
	case zone == "", zone == "Z", strings.EqualFold(zone, "UTC"):
		return t.UTC(), nil
	case len(zone) == 5 && (zone[0] == '+' || zone[0] == '-'):
		offset, ok := zoneOffset(zone)
		if !ok {
			return time.Time{}, errors.New("livetv: a guide time's offset is out of range")
		}
		// The offset is how far ahead of UTC the time is, so UTC is behind.
		return t.Add(-offset).UTC(), nil
	}
	return time.Time{}, errors.New("livetv: a guide time's offset isn't UTC")
}

// zoneOffset reads "+0100" as one hour ahead of UTC.
func zoneOffset(zone string) (time.Duration, bool) {
	digits := func(s string) (int, bool) {
		for i := 0; i < len(s); i++ {
			if s[i] < '0' || s[i] > '9' {
				return 0, false
			}
		}
		n, err := strconv.Atoi(s)
		return n, err == nil
	}
	hours, ok := digits(zone[1:3])
	if !ok || hours > 23 {
		return 0, false
	}
	minutes, ok := digits(zone[3:5])
	if !ok || minutes > 59 {
		return 0, false
	}
	offset := time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute
	if zone[0] == '-' {
		offset = -offset
	}
	return offset, true
}

// charsetReader decodes the encodings guides still declare. The single-byte
// ones only need each byte read as its own code point.
func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "iso-8859-1", "latin1", "latin-1", "windows-1252":
		return &latin1Reader{r: input}, nil
	}
	return input, nil
}

// latin1Reader reads single-byte text as UTF-8.
type latin1Reader struct {
	r   io.Reader
	buf []byte
	at  int
}

func (l *latin1Reader) Read(p []byte) (int, error) {
	if l.at >= len(l.buf) {
		if len(p) == 0 {
			return 0, nil
		}
		src := make([]byte, 4096)
		n, err := l.r.Read(src)
		if n == 0 {
			return 0, err
		}
		l.buf = l.buf[:0]
		for _, b := range src[:n] {
			l.buf = utf8.AppendRune(l.buf, rune(b))
		}
		l.at = 0
	}
	n := copy(p, l.buf[l.at:])
	l.at += n
	return n, nil
}
