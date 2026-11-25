package livetv

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// GuideChannel is one XMLTV <channel> element.
type GuideChannel struct {
	ID    string   // the id attribute
	Names []string // every <display-name>, in order
}

var (
	// countryPrefix is how guides group their channels ("US: CNN", "UK | BBC
	// One"); it says nothing about which channel it is.
	countryPrefix = regexp.MustCompile(`^[A-Za-z]{2,3}\s*[:|]\s*`)
	// bracketed is a qualifier a name may or may not carry ("CNN (East)").
	bracketed = regexp.MustCompile(`\([^()]*\)|\[[^\[\]]*\]`)
)

// qualityWords are the picture-quality tags a name may end with. They tell
// the same channel's feeds apart, so they're dropped when a name is compared.
var qualityWords = map[string]bool{
	"hd": true, "fhd": true, "uhd": true, "sd": true, "4k": true, "hevc": true,
	"h265": true, "1080p": true, "720p": true, "1080": true, "720": true, "hq": true,
}

// Matcher maps a guide's channels onto a playlist's channels.
type Matcher struct {
	channels []Channel
	// byTvgID and byName hold our Channel.IDs, in Channels order, under a
	// lowercased trimmed tvg-id and under a NormaliseName of Name and TvgName.
	byTvgID map[string][]string
	byName  map[string][]string
}

// NewMatcher returns a Matcher for channels.
func NewMatcher(channels []Channel) *Matcher {
	m := &Matcher{
		channels: channels,
		byTvgID:  make(map[string][]string, len(channels)),
		byName:   make(map[string][]string, 2*len(channels)),
	}
	add := func(index map[string][]string, key, id string) {
		for _, have := range index[key] {
			if have == id {
				return
			}
		}
		index[key] = append(index[key], id)
	}
	for _, c := range channels {
		if key := strings.ToLower(strings.TrimSpace(c.TvgID)); key != "" {
			add(m.byTvgID, key, c.ID)
		}
		for _, name := range []string{c.Name, c.TvgName} {
			if key := NormaliseName(name); key != "" {
				add(m.byName, key, c.ID)
			}
		}
	}
	return m
}

// Resolve maps each guide channel's ID to our Channel.IDs it matches. A
// guide channel is matched by tvg-id first, and only by name when that gives
// nothing: names are all a guide and a playlist have in common, so they're
// the fallback rather than the rule.
func (m *Matcher) Resolve(guide []GuideChannel) map[string][]string {
	resolved := make(map[string][]string, len(guide))

	// The tvg-ids the guide names channels for: a playlist channel carrying
	// one of them belongs to that guide channel, whatever else it's called.
	guideIDs := make(map[string]bool, len(guide))
	for _, gc := range guide {
		if key := strings.ToLower(strings.TrimSpace(gc.ID)); key != "" {
			guideIDs[key] = true
		}
	}

	matched := make(map[string]bool, len(guide))
	for _, gc := range guide {
		ids := m.byTvgID[strings.ToLower(strings.TrimSpace(gc.ID))]
		if len(ids) == 0 {
			continue
		}
		resolved[gc.ID] = append([]string(nil), ids...)
		for _, id := range ids {
			matched[id] = true
		}
	}

	for _, gc := range guide {
		if len(resolved[gc.ID]) > 0 {
			continue
		}
		candidates := make(map[string]bool)
		for _, name := range gc.Names {
			for _, id := range m.byName[NormaliseName(name)] {
				candidates[id] = true
			}
		}
		if len(candidates) == 0 {
			continue
		}
		// Our channels' order, and no channel that a tvg-id already spoke for.
		var ids []string
		added := make(map[string]bool, len(candidates))
		for _, c := range m.channels {
			if !candidates[c.ID] || added[c.ID] {
				continue
			}
			added[c.ID] = true
			if matched[c.ID] {
				continue
			}
			if key := strings.ToLower(strings.TrimSpace(c.TvgID)); key != "" && guideIDs[key] {
				continue
			}
			ids = append(ids, c.ID)
		}
		if len(ids) > 0 {
			resolved[gc.ID] = ids
		}
	}
	return resolved
}

// ByTvgID returns our Channel.IDs whose tvg-id is id. Programmes whose guide
// channel has no <channel> element are matched this way.
func (m *Matcher) ByTvgID(id string) []string {
	ids := m.byTvgID[strings.ToLower(strings.TrimSpace(id))]
	if len(ids) == 0 {
		return nil
	}
	return append([]string(nil), ids...)
}

// NormaliseName folds a channel name so that a guide's and a playlist's
// spelling of it compare equal: "BBC One HD", "UK: BBC One" and "BBC1 [HD]"
// all come out the same.
func NormaliseName(name string) string {
	s := strings.TrimSpace(name)
	s = countryPrefix.ReplaceAllString(s, "")
	s = bracketed.ReplaceAllString(s, "")
	s = strings.ToLower(s)
	// Accents are spelling, not identity: "Télé-Québec" is "telequebec".
	s = norm.NFD.String(s)
	s = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Mn, r) {
			return -1
		}
		return r
	}, s)
	s = strings.ReplaceAll(s, "&", " and ")
	s = strings.ReplaceAll(s, "+", " plus ")
	words := strings.FieldsFunc(s, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for len(words) > 1 && qualityWords[words[len(words)-1]] {
		words = words[:len(words)-1]
	}
	return strings.Join(words, "")
}
