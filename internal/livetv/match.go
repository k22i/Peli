package livetv

// GuideChannel is one XMLTV <channel> element.
type GuideChannel struct {
	ID    string   // the id attribute
	Names []string // every <display-name>, in order
}

// Matcher maps a guide's channels onto a playlist's channels.
type Matcher struct {
	channels []Channel
}

// NewMatcher returns a Matcher for channels (W2: TODO).
func NewMatcher(channels []Channel) *Matcher {
	return &Matcher{channels: channels}
}

// Resolve maps each guide channel's ID to our Channel.IDs it matches
// (W2: TODO).
func (m *Matcher) Resolve(guide []GuideChannel) map[string][]string {
	_ = guide
	return map[string][]string{}
}

// ByTvgID returns our Channel.IDs whose tvg-id is id (W2: TODO).
func (m *Matcher) ByTvgID(id string) []string {
	_ = id
	return nil
}

// NormaliseName folds a channel name for matching (W2: TODO).
func NormaliseName(name string) string {
	return name
}
