package livetv

import (
	"regexp"
	"testing"
)

// channelIDPattern is the id the frontend and the store see: the source, a
// colon, and twelve hex characters.
var channelIDPattern = regexp.MustCompile(`^src:[0-9a-f]{12}$`)

// TestChannelsOf gives the entries their numbers and fields, in order.
func TestChannelsOf(t *testing.T) {
	p := Playlist{Entries: []Entry{
		{
			Name:    "Channel One",
			TvgID:   "one.example",
			TvgName: "One",
			Logo:    "https://a.example/one.png",
			Group:   "News",
			URL:     "https://a.example/one.m3u8",
		},
		{
			Name:  "Channel Two",
			Group: " Sport ",
			URL:   "https://a.example/two.m3u8",
		},
	}}

	channels := ChannelsOf("src", p)
	if len(channels) != len(p.Entries) {
		t.Fatalf("%d channels, want %d", len(channels), len(p.Entries))
	}
	for i, c := range channels {
		if c.Number != i+1 {
			t.Errorf("channel %d: Number = %d, want %d; numbers count from 1", i, c.Number, i+1)
		}
		if !channelIDPattern.MatchString(c.ID) {
			t.Errorf("channel %d: ID = %q, want src: and twelve hex characters", i, c.ID)
		}
		if c.SourceID != "src" {
			t.Errorf("channel %d: SourceID = %q", i, c.SourceID)
		}
		if c.Name != p.Entries[i].Name || c.Logo != p.Entries[i].Logo {
			t.Errorf("channel %d = %+v, want the entry's name and logo", i, c)
		}
	}
	if first := channels[0]; first.TvgID != "one.example" || first.TvgName != "One" || first.Group != "News" {
		t.Errorf("the first channel = %+v", first)
	}
	if second := channels[1]; second.TvgID != "" || second.Group != "Sport" {
		t.Errorf("the second channel = %+v, want a trimmed group and no tvg-id", second)
	}
	if channels[0].ID == channels[1].ID {
		t.Error("two different channels share an id")
	}
}

// TestChannelsOfStableIDs checks that an id survives a refresh: Xtream links
// carry a token that changes on every fetch.
func TestChannelsOfStableIDs(t *testing.T) {
	before := ChannelsOf("src", Playlist{Entries: []Entry{{
		Name:  "Channel One",
		TvgID: "one.example",
		Group: "News",
		URL:   "https://a.example/live/user/pass/1.m3u8",
	}}})
	after := ChannelsOf("src", Playlist{Entries: []Entry{{
		Name:  "Channel One",
		TvgID: "one.example",
		Group: "News",
		URL:   "https://a.example/live/token/1.m3u8",
	}}})
	if len(before) != 1 || len(after) != 1 {
		t.Fatalf("ChannelsOf gave %d and %d channels, want one each", len(before), len(after))
	}
	if before[0].ID != after[0].ID {
		t.Errorf("ID = %q after the URL changed, was %q", after[0].ID, before[0].ID)
	}
}

// TestChannelsOfDuplicates checks that a channel listed twice keeps a place of
// its own, so neither copy takes the other's favourites.
func TestChannelsOfDuplicates(t *testing.T) {
	entry := Entry{
		Name:  "Channel One",
		TvgID: "one.example",
		Group: "News",
		URL:   "https://a.example/one.m3u8",
	}

	channels := ChannelsOf("src", Playlist{Entries: []Entry{entry, entry, entry}})
	if len(channels) != 3 {
		t.Fatalf("%d channels, want 3", len(channels))
	}
	id := channels[0].ID
	if channels[1].ID != id+"~2" {
		t.Errorf("the second copy's ID = %q, want %q", channels[1].ID, id+"~2")
	}
	if channels[2].ID != id+"~3" {
		t.Errorf("the third copy's ID = %q, want %q", channels[2].ID, id+"~3")
	}
	if channels[1].Name != "Channel One" || channels[2].Number != 3 {
		t.Errorf("a copy lost its name or number: %+v", channels)
	}
}
