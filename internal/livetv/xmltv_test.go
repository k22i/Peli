package livetv

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The playlist channels the guide tests match against: two the guide names
// with a <channel> element, one it doesn't, and one it never mentions.
const (
	bbcChannelID  = "src:000000000001"
	itvChannelID  = "src:000000000002"
	cnnChannelID  = "src:000000000003"
	daveChannelID = "src:000000000004"
)

// xmltvWindow is the window small.xml is parsed with: a day from noon UTC.
func xmltvWindow() (time.Time, time.Time) {
	from := time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC)
	return from, from.Add(24 * time.Hour)
}

func xmltvPlaylist() []Channel {
	return []Channel{
		{ID: bbcChannelID, Name: "BBC One HD", TvgID: "bbc1.uk"},
		{ID: itvChannelID, Name: "ITV1", TvgID: "itv.uk"},
		{ID: cnnChannelID, Name: "CNN International", TvgID: "cnn.us"},
		{ID: daveChannelID, Name: "Dave", TvgID: "dave.uk"},
	}
}

func xmltvFixture(t *testing.T, name string) []byte {
	t.Helper()
	path := filepath.Join("testdata", "xmltv", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return data
}

func parseXMLTV(t *testing.T, data []byte, from, to time.Time) Guide {
	t.Helper()
	guide, err := ParseGuide(bytes.NewReader(data), NewMatcher(xmltvPlaylist()), from, to)
	if err != nil {
		t.Fatalf("ParseGuide: %v", err)
	}
	return guide
}

// guideStamp is a programme time in the test's own terms, so a failure reads as
// a time rather than a number of milliseconds.
func guideStamp(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("01-02 15:04")
}

// guideSummaries renders a channel's programmes as "start|stop|title|sub-title|
// episode|categories", which is enough to see the whole chain at once.
func guideSummaries(guide Guide, channelID string) []string {
	programmes := guide.Programmes[channelID]
	lines := make([]string, 0, len(programmes))
	for _, p := range programmes {
		lines = append(lines, strings.Join([]string{
			guideStamp(p.Start), guideStamp(p.Stop), p.Title, p.SubTitle, p.Episode,
			strings.Join(p.Categories, ", "),
		}, "|"))
	}
	return lines
}

func checkGuideSummaries(t *testing.T, guide Guide, channelID string, want ...string) {
	t.Helper()
	got := guideSummaries(guide, channelID)
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s programmes:\n got %s\nwant %s", channelID, quoteGuideLines(got), quoteGuideLines(want))
	}
}

func quoteGuideLines(lines []string) string {
	if len(lines) == 0 {
		return "(none)"
	}
	quoted := make([]string, 0, len(lines))
	for _, line := range lines {
		quoted = append(quoted, fmt.Sprintf("\n  %q", line))
	}
	return strings.Join(quoted, "")
}

// TestParseGuide is small.xml: what the window keeps, what the times and
// offsets come out as, and what each channel's list looks like.
func TestParseGuide(t *testing.T) {
	from, to := xmltvWindow()
	guide := parseXMLTV(t, xmltvFixture(t, "small.xml"), from, to)

	t.Run("counts", func(t *testing.T) {
		if guide.GuideChannels != 3 {
			t.Errorf("GuideChannels = %d, want 3", guide.GuideChannels)
		}
		// bbc1.uk and itv.uk by their <channel> elements, dave.uk by its
		// tvg-id alone; us.cnn matches nothing.
		if guide.Matched != 3 {
			t.Errorf("Matched = %d, want 3", guide.Matched)
		}
	})

	t.Run("outside the window is dropped, straddling it is kept", func(t *testing.T) {
		checkGuideSummaries(t, guide, bbcChannelID,
			"03-14 11:00|03-14 12:30|Morning Live|||",
			"03-14 12:00|03-14 13:00|Homes Under the Hammer|Series 12|S1 E3|Factual, Homes",
			"03-14 20:00|03-15 02:00|The Repair Shop|||",
			"03-15 02:00|03-15 03:00|Late Film|||",
			"03-15 06:00|03-15 08:00|Breakfast|||",
			"03-15 08:00|03-15 08:30|Weather|||",
		)
	})

	t.Run("a channel with no programme in the window is left out", func(t *testing.T) {
		if programmes, ok := guide.Programmes[cnnChannelID]; ok {
			t.Errorf("cnn programmes = %v, want none", programmes)
		}
	})

	t.Run("a programme is kept for a tvg-id with no channel element", func(t *testing.T) {
		checkGuideSummaries(t, guide, daveChannelID,
			"03-15 09:00|03-15 10:00|Would I Lie to You?|||",
		)
	})

	t.Run("times are unix milliseconds in UTC", func(t *testing.T) {
		// "20260314130000 +0100" is noon UTC, and "20260314210000 -0500" is
		// two in the morning the next day.
		programmes := guide.Programmes[bbcChannelID]
		if len(programmes) < 4 {
			t.Fatalf("programmes = %d, want 6", len(programmes))
		}
		want := time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC).UnixMilli()
		if got := programmes[1].Start; got != want {
			t.Errorf("the +0100 programme starts at %d, want %d", got, want)
		}
		want = time.Date(2026, 3, 15, 2, 0, 0, 0, time.UTC).UnixMilli()
		if got := programmes[3].Start; got != want {
			t.Errorf("the -0500 programme starts at %d, want %d", got, want)
		}
	})

	t.Run("the first title, description and icon win", func(t *testing.T) {
		programmes := guide.Programmes[bbcChannelID]
		if len(programmes) < 2 {
			t.Fatalf("programmes = %d, want 6", len(programmes))
		}
		homes := programmes[1]
		if homes.Title != "Homes Under the Hammer" {
			t.Errorf("Title = %q, want the English title", homes.Title)
		}
		if homes.Description != "A cottage in Devon gets a new roof." {
			t.Errorf("Description = %q, want it trimmed", homes.Description)
		}
		if homes.Icon != "https://example.test/huth.png" {
			t.Errorf("Icon = %q, want the icon's src", homes.Icon)
		}
		if len(programmes[0].Categories) != 0 {
			t.Errorf("Categories = %v, want none", programmes[0].Categories)
		}
	})

	t.Run("episodes", func(t *testing.T) {
		itv := guide.Programmes[itvChannelID]
		if len(itv) < 2 {
			t.Fatalf("programmes = %d, want 2", len(itv))
		}
		// "1/3.9/10.0/1" is season 1 of 3, episode 9 of 10: shown from 1.
		if itv[0].Episode != "S2 E10" {
			t.Errorf("xmltv_ns episode = %q, want %q", itv[0].Episode, "S2 E10")
		}
		// No xmltv_ns value, so the channel's own text stands in.
		if itv[1].Episode != "S01E05" {
			t.Errorf("onscreen episode = %q, want %q", itv[1].Episode, "S01E05")
		}
	})

	t.Run("every programme names one of our channels", func(t *testing.T) {
		for id, programmes := range guide.Programmes {
			for _, p := range programmes {
				if p.ChannelID != id {
					t.Errorf("programme %q has ChannelID %q under %q", p.Title, p.ChannelID, id)
				}
			}
		}
	})
}

// TestParseGuideGzip is the same file zipped, which is how most guides
// arrive.
func TestParseGuideGzip(t *testing.T) {
	from, to := xmltvWindow()
	data := xmltvFixture(t, "small.xml")

	var zipped bytes.Buffer
	zw := gzip.NewWriter(&zipped)
	if _, err := zw.Write(data); err != nil {
		t.Fatalf("gzipping the fixture: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzipping the fixture: %v", err)
	}

	reader, err := GuideReader(bytes.NewReader(zipped.Bytes()))
	if err != nil {
		t.Fatalf("GuideReader: %v", err)
	}
	unzipped, err := ParseGuide(reader, NewMatcher(xmltvPlaylist()), from, to)
	if err != nil {
		t.Fatalf("ParseGuide: %v", err)
	}

	plain := parseXMLTV(t, data, from, to)
	if !reflect.DeepEqual(unzipped, plain) {
		t.Errorf("the gzipped guide parsed differently:\n got %v\nwant %v", unzipped, plain)
	}
}

// TestGuideReaderPlain checks a document that isn't gzipped comes back as it
// went in, short ones too.
func TestGuideReaderPlain(t *testing.T) {
	for _, input := range []string{"<tv></tv>", "<"} {
		reader, err := GuideReader(strings.NewReader(input))
		if err != nil {
			t.Fatalf("GuideReader(%q): %v", input, err)
		}
		got, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("reading back %q: %v", input, err)
		}
		if string(got) != input {
			t.Errorf("GuideReader(%q) gave %q", input, string(got))
		}
	}
}

func TestParseGuideLatin1(t *testing.T) {
	from, to := xmltvWindow()
	playlist := []Channel{{ID: "src:tf1", Name: "TF1", TvgID: "fr.tf1"}}
	guide, err := ParseGuide(bytes.NewReader(xmltvFixture(t, "latin1.xml")), NewMatcher(playlist), from, to)
	if err != nil {
		t.Fatalf("ParseGuide: %v", err)
	}
	programmes := guide.Programmes["src:tf1"]
	if len(programmes) != 1 {
		t.Fatalf("programmes = %d, want 1", len(programmes))
	}
	if programmes[0].Title != "Le café" {
		t.Errorf("Title = %q, want %q", programmes[0].Title, "Le café")
	}
}

func TestParseGuideErrors(t *testing.T) {
	from, to := xmltvWindow()
	playlist := NewMatcher(xmltvPlaylist())

	t.Run("not a guide", func(t *testing.T) {
		_, err := ParseGuide(strings.NewReader(`<html><body>404</body></html>`), playlist, from, to)
		if !errors.Is(err, ErrNotGuide) {
			t.Errorf("err = %v, want ErrNotGuide", err)
		}
	})

	t.Run("an empty tv element", func(t *testing.T) {
		_, err := ParseGuide(strings.NewReader(`<tv></tv>`), playlist, from, to)
		if !errors.Is(err, ErrNotGuide) {
			t.Errorf("err = %v, want ErrNotGuide", err)
		}
	})

	t.Run("nothing at all", func(t *testing.T) {
		_, err := ParseGuide(strings.NewReader(""), playlist, from, to)
		if !errors.Is(err, ErrNotGuide) {
			t.Errorf("err = %v, want ErrNotGuide", err)
		}
	})

	t.Run("truncated", func(t *testing.T) {
		_, err := ParseGuide(strings.NewReader(`<tv><channel id="bbc1.uk"><display-name>BBC One`), playlist, from, to)
		if err == nil {
			t.Fatal("err = nil, want an error")
		}
		if errors.Is(err, ErrNotGuide) {
			t.Errorf("err = %v, want a reading error", err)
		}
	})

	t.Run("truncated between elements", func(t *testing.T) {
		_, err := ParseGuide(strings.NewReader(`<tv><channel id="bbc1.uk"></channel>`), playlist, from, to)
		if err == nil {
			t.Fatal("err = nil, want an error")
		}
	})

	t.Run("channels with nothing in the window is not an error", func(t *testing.T) {
		later := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
		guide, err := ParseGuide(bytes.NewReader(xmltvFixture(t, "small.xml")), playlist, later, later.Add(24*time.Hour))
		if err != nil {
			t.Fatalf("ParseGuide: %v", err)
		}
		if len(guide.Programmes) != 0 {
			t.Errorf("programmes = %v, want none", guide.Programmes)
		}
		if guide.GuideChannels != 3 || guide.Matched != 3 {
			t.Errorf("GuideChannels = %d, Matched = %d, want 3 and 3", guide.GuideChannels, guide.Matched)
		}
	})
}

func TestParseTime(t *testing.T) {
	utc := func(day, hour, minute int) time.Time {
		return time.Date(2026, 3, day, hour, minute, 0, 0, time.UTC)
	}
	cases := []struct {
		value string
		want  time.Time
		bad   bool
	}{
		{value: "20260314120000 +0000", want: utc(14, 12, 0)},
		{value: "20260314120000", want: utc(14, 12, 0)},
		{value: "20260314120000Z", want: utc(14, 12, 0)},
		{value: "20260314120000 UTC", want: utc(14, 12, 0)},
		{value: "20260314123000 +0100", want: utc(14, 11, 30)},
		{value: "20260314120000 -0500", want: utc(14, 17, 0)},
		{value: " 20260314120000+0130 ", want: utc(14, 10, 30)},
		{value: "202603141200", want: utc(14, 12, 0)},
		{value: "202603141200 +0200", want: utc(14, 10, 0)},
		{value: "20260314", want: utc(14, 0, 0)},
		{value: "20260314 -0500", want: utc(14, 5, 0)},
		{value: "20260314120000 +2400", bad: true},
		{value: "20260314120000 +0060", bad: true},
		{value: "20260314120000 CEST", bad: true},
		{value: "20260314120000.5 +0000", bad: true},
		{value: "2026031412000", bad: true},
		{value: "abc", bad: true},
		{value: "", bad: true},
	}
	for _, c := range cases {
		got, err := parseTime(c.value)
		if c.bad {
			if err == nil {
				t.Errorf("parseTime(%q) = %v, want an error", c.value, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseTime(%q): %v", c.value, err)
			continue
		}
		if !got.Equal(c.want) {
			t.Errorf("parseTime(%q) = %v, want %v", c.value, got, c.want)
		}
		if got.Location() != time.UTC {
			t.Errorf("parseTime(%q) is in %v, want UTC", c.value, got.Location())
		}
	}
}

// writeLargeXMLTVGuide streams a guide of channelCount channels, each with
// perChannel half-hour programmes from base, into w.
func writeLargeXMLTVGuide(w io.Writer, base time.Time, channelCount, perChannel int, slot time.Duration) error {
	bw := bufio.NewWriterSize(w, 64<<10)
	if _, err := bw.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n"); err != nil {
		return err
	}
	for c := 0; c < channelCount; c++ {
		if _, err := fmt.Fprintf(bw, "  <channel id=\"ch%04d\">\n    <display-name>Channel %d</display-name>\n  </channel>\n", c, c); err != nil {
			return err
		}
	}
	for c := 0; c < channelCount; c++ {
		for p := 0; p < perChannel; p++ {
			start := base.Add(time.Duration(p) * slot)
			stop := start.Add(slot)
			if _, err := fmt.Fprintf(bw,
				"  <programme start=\"%s +0000\" stop=\"%s +0000\" channel=\"ch%04d\">\n"+
					"    <title lang=\"en\">Programme %d on channel %d, a title long enough to count</title>\n"+
					"    <desc>A description, so that each programme is about three hundred bytes.</desc>\n"+
					"    <category>Entertainment</category>\n"+
					"  </programme>\n",
				start.Format("20060102150405"), stop.Format("20060102150405"), c, p, c); err != nil {
				return err
			}
		}
	}
	if _, err := bw.WriteString("</tv>\n"); err != nil {
		return err
	}
	return bw.Flush()
}

// BenchmarkParseGuideLarge parses a 150 MB guide that is only ever produced
// as it is read: run it with -bench ParseGuideLarge -benchtime 1x.
func BenchmarkParseGuideLarge(b *testing.B) {
	const (
		channelCount = 2000
		perChannel   = 250
		ourChannels  = 500
		slot         = 30 * time.Minute
	)
	base := time.Date(2026, 3, 14, 0, 0, 0, 0, time.UTC)
	from := base.Add(24 * time.Hour)
	to := from.Add(38 * time.Hour)

	playlist := make([]Channel, 0, ourChannels)
	for i := 0; i < ourChannels; i++ {
		playlist = append(playlist, Channel{
			ID:    fmt.Sprintf("our:%04d", i),
			Name:  fmt.Sprintf("Channel %d", i),
			TvgID: fmt.Sprintf("ch%04d", i),
		})
	}
	matcher := NewMatcher(playlist)

	b.ReportAllocs()
	b.ReportMetric(float64(channelCount*perChannel), "programmes")
	for i := 0; i < b.N; i++ {
		reader, writer := io.Pipe()
		go func() {
			if err := writeLargeXMLTVGuide(writer, base, channelCount, perChannel, slot); err != nil {
				_ = writer.CloseWithError(err)
				return
			}
			_ = writer.Close()
		}()
		guide, err := ParseGuide(reader, matcher, from, to)
		_ = reader.Close()
		if err != nil {
			b.Fatalf("ParseGuide: %v", err)
		}
		if len(guide.Programmes) == 0 {
			b.Fatal("no programmes kept")
		}
	}
}
