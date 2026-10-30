package markers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/k22i/Sinag/internal/store"
)

// IntroDB's answers, as recorded on 2026-10-31: Breaking Bad's S2E3 (intro
// and credits), and a film with credits, a post-credits scene, and an
// "intro" someone put after the credits.
const (
	episode = `{"imdb_id":"tt0903747","media_type":"tv","is_movie":false,"season":2,"episode":3,
		"intro":{"start_sec":216,"end_sec":232,"start_ms":216000,"end_ms":232000,"confidence":1,"submission_count":1,"updated_at":"2026-04-08T18:47:54.773Z"},
		"recap":null,
		"outro":{"start_sec":2770,"end_sec":2828,"start_ms":2770000,"end_ms":2828000,"confidence":1,"submission_count":1,"updated_at":"2026-04-14T12:26:10.078Z"},
		"post_credits":null,"no_intro":false,"no_recap":false,"no_outro":false}`
	film = `{"imdb_id":"tt0371746","media_type":"movie","is_movie":true,"season":0,"episode":0,
		"intro":{"start_sec":7512,"end_sec":7545,"start_ms":7512000,"end_ms":7545000,"confidence":1,"submission_count":1,"updated_at":"2026-09-16T13:13:26.441Z"},
		"recap":null,
		"outro":{"start_sec":7038,"end_sec":7540,"start_ms":7038000,"end_ms":7540000,"confidence":1,"submission_count":1,"updated_at":"2026-09-12T20:55:48.377Z"},
		"post_credits":{"start_sec":7540,"end_sec":7580,"start_ms":7540000,"end_ms":7580000,"confidence":1,"submission_count":1,"updated_at":"2026-09-12T21:02:11.302Z"},
		"no_intro":false,"no_recap":false,"no_outro":false}`
)

type settings struct{ online bool }

func (s settings) DeviceSettings() (store.DeviceSettings, error) {
	return store.DeviceSettings{SkipTimesOnline: s.online}, nil
}

// introDB answers GET /segments with answers by query, 404 for the rest,
// and keeps every query it was asked.
func introDB(t *testing.T, answers map[string]string) (*Service, *[]string) {
	t.Helper()
	var asked []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.RawQuery)
		if r.URL.Path != "/segments" || r.Header.Get("User-Agent") == "" {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
			return
		}
		body, ok := answers[r.URL.RawQuery]
		if !ok {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	s := NewService("test")
	s.base = server.URL
	return s, &asked
}

func TestSegments(t *testing.T) {
	s, _ := introDB(t, map[string]string{
		"episode=3&imdb_id=tt0903747&season=2": episode,
		"imdb_id=tt0371746&is_movie=true":      film,
	})
	for name, test := range map[string]struct {
		title Title
		want  []Segment
	}{
		"an episode": {Title{IMDbID: "tt0903747", Season: 2, Episode: 3}, []Segment{
			{Kind: KindIntro, Start: 216, End: 232}, {Kind: KindCredits, Start: 2770, End: 2828},
		}},
		// The scene after the credits is for watching. Its "intro" after
		// them is as IntroDB has it; the frontend drops it.
		"a film": {Title{IMDbID: "tt0371746"}, []Segment{
			{Kind: KindIntro, Start: 7512, End: 7545}, {Kind: KindCredits, Start: 7038, End: 7540},
		}},
		"unknown": {Title{IMDbID: "tt0903747", Season: 9, Episode: 1}, []Segment{}},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := s.Segments(context.Background(), test.title)
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("Segments = %+v, %v; want %+v", got, err, test.want)
			}
		})
	}
}

func TestSegmentsAsksNothingForOtherIDs(t *testing.T) {
	s, asked := introDB(t, nil)
	for _, title := range []Title{
		{IMDbID: "kitsu:7442", Episode: 1},
		{IMDbID: "tt0903747&season=1", Season: 1, Episode: 1},
		{IMDbID: "tt0903747", Season: -1, Episode: 1},
	} {
		got, err := s.Segments(context.Background(), title)
		if err != nil || len(got) != 0 {
			t.Errorf("Segments(%+v) = %+v, %v; want none", title, got, err)
		}
	}
	if len(*asked) != 0 {
		t.Errorf("asked IntroDB %q", *asked)
	}
}

func TestSegmentsFollowSettings(t *testing.T) {
	s, asked := introDB(t, map[string]string{"episode=3&imdb_id=tt0903747&season=2": episode})
	title := Title{IMDbID: "tt0903747", Season: 2, Episode: 3}

	UseSettings(s, settings{online: false})
	if got, err := s.Segments(context.Background(), title); err != nil || len(got) != 0 || len(*asked) != 0 {
		t.Fatalf("turned off: Segments = %+v, %v after %d requests; want none and none", got, err, len(*asked))
	}
	UseSettings(s, settings{online: true})
	if got, err := s.Segments(context.Background(), title); err != nil || len(got) != 2 {
		t.Fatalf("turned on: Segments = %+v, %v", got, err)
	}
}

func TestSegmentsUnavailable(t *testing.T) {
	for name, status := range map[string]int{"rate limited": http.StatusTooManyRequests, "down": http.StatusBadGateway} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
			}))
			defer server.Close()
			s := NewService("test")
			s.base = server.URL
			_, err := s.Segments(context.Background(), Title{IMDbID: "tt0903747", Season: 1, Episode: 1})
			if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("err = %v; want ErrUnavailable", err)
			}
		})
	}
}
