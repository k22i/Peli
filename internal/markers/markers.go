// Package markers finds where a film's or episode's intro, recap and
// credits are (#69), from IntroDB (introdb.app): a community database of
// skip times by IMDb id, read without a key. The player's own chapters, read
// from the file in the frontend, come first; these are for files without
// them. IntroDB answers browsers from its own site only (CORS), so Go asks
// it. See ADR-0039, "Skip intro and credits (#69)".
package markers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/k22i/Sinag/internal/store"
)

// Segment kinds.
const (
	KindIntro   = "intro"
	KindRecap   = "recap"
	KindCredits = "credits"
)

// Segment is a part of the file to skip, in seconds from its start.
type Segment struct {
	Kind  string  `json:"kind"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// Title names a film, or a series' episode, by IMDb id ("tt0903747").
// Season and Episode are 0 for a film.
type Title struct {
	IMDbID  string `json:"imdbId"`
	Season  int    `json:"season"`
	Episode int    `json:"episode"`
}

// Settings is where the service reads whether it may ask IntroDB: the
// store's device settings.
type Settings interface {
	DeviceSettings() (store.DeviceSettings, error)
}

// ErrUnavailable means IntroDB couldn't be reached, was rate limiting, or
// answered with something other than its JSON.
var ErrUnavailable = errors.New("markers: IntroDB unavailable")

// MaxWait caps one lookup: the skip button can do without it.
const MaxWait = 10 * time.Second

// DefaultBase is IntroDB's API.
const DefaultBase = "https://api.introdb.app"

var imdbID = regexp.MustCompile(`^tt\d{1,10}$`)

// Service is the Wails service the player screen asks for a title's
// segments.
type Service struct {
	base      string
	userAgent string
	http      *http.Client
	// settings are nil until UseSettings: lookups stay on.
	settings Settings
}

// NewService returns a Service that asks IntroDB, sending version in its
// User-Agent.
func NewService(version string) *Service {
	return &Service{
		base:      DefaultBase,
		userAgent: fmt.Sprintf("Sinag/%s (+https://github.com/k22i/Sinag)", version),
		http:      &http.Client{Timeout: MaxWait},
	}
}

// UseSettings has the service ask IntroDB only while the device's settings
// allow it. It isn't a method, so Wails doesn't bind it.
func UseSettings(s *Service, settings Settings) { s.settings = settings }

// Segments returns title's intro, recap and credits, as IntroDB has them:
// none when it has none, when the id isn't an IMDb one (Kitsu's anime ids),
// or when lookups are turned off in Settings.
func (s *Service) Segments(ctx context.Context, title Title) ([]Segment, error) {
	if !imdbID.MatchString(title.IMDbID) || title.Season < 0 || title.Episode < 0 || !s.allowed() {
		return []Segment{}, nil
	}
	query := url.Values{"imdb_id": {title.IMDbID}}
	if title.Season == 0 && title.Episode == 0 {
		query.Set("is_movie", "true")
	} else {
		query.Set("season", strconv.Itoa(title.Season))
		query.Set("episode", strconv.Itoa(title.Episode))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.base+"/segments?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", s.userAgent)
	req.Header.Set("Accept", "application/json")
	res, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusNotFound:
		return []Segment{}, nil
	case res.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%w: HTTP %d", ErrUnavailable, res.StatusCode)
	}
	var body answer
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return body.segments(), nil
}

func (s *Service) allowed() bool {
	if s.settings == nil {
		return true
	}
	d, err := s.settings.DeviceSettings()
	if err != nil {
		slog.Warn("markers: device settings unread", "error", err)
		return false
	}
	return d.SkipTimesOnline
}

// answer is IntroDB's GET /segments. A segment it has no times for is null.
// Its "outro" is the end credits; "post_credits", a scene after them, is
// for watching, so it isn't skipped.
type answer struct {
	Intro *times `json:"intro"`
	Recap *times `json:"recap"`
	Outro *times `json:"outro"`
}

type times struct {
	Start float64 `json:"start_sec"`
	End   float64 `json:"end_sec"`
}

func (a answer) segments() []Segment {
	out := []Segment{}
	for _, part := range []struct {
		kind string
		t    *times
	}{{KindRecap, a.Recap}, {KindIntro, a.Intro}, {KindCredits, a.Outro}} {
		if part.t != nil && part.t.Start >= 0 && part.t.End > part.t.Start {
			out = append(out, Segment{Kind: part.kind, Start: part.t.Start, End: part.t.End})
		}
	}
	return out
}
