package livetv

import (
	"errors"
	"io"
	"time"
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

// GuideReader returns r, unzipped if it starts with gzip's magic bytes
// (W2: TODO).
func GuideReader(r io.Reader) (io.Reader, error) {
	return r, nil
}

// ParseGuide streams an XMLTV document and keeps the programmes of the
// channels m matches that overlap [from, to) (W2: TODO).
func ParseGuide(r io.Reader, m *Matcher, from, to time.Time) (Guide, error) {
	_, _, _, _ = r, m, from, to
	return Guide{Programmes: map[string][]Programme{}}, ErrNotGuide
}
