package livetv

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

// ChannelsOf gives each entry of a playlist its Channel, in the same order
// (index i of the result is p.Entries[i]), with a stable ID.
func ChannelsOf(sourceID string, p Playlist) []Channel {
	channels := make([]Channel, 0, len(p.Entries))
	// taken holds the ids this playlist has already used, so a channel listed
	// twice gets an id of its own.
	taken := make(map[string]struct{}, len(p.Entries))

	for i, e := range p.Entries {
		name := strings.TrimSpace(e.Name)
		group := strings.TrimSpace(e.Group)
		tvgID := strings.TrimSpace(e.TvgID)

		base := channelID(sourceID, tvgID, name, group)
		id := base
		for n := 2; ; n++ {
			if _, dup := taken[id]; !dup {
				break
			}
			id = base + "~" + strconv.Itoa(n)
		}
		taken[id] = struct{}{}

		channels = append(channels, Channel{
			ID:       id,
			SourceID: sourceID,
			Number:   i + 1,
			Name:     name,
			Logo:     e.Logo,
			Group:    group,
			TvgID:    tvgID,
			TvgName:  e.TvgName,
		})
	}
	return channels
}

// channelID hashes what makes a channel the same channel across refreshes: its
// tvg-id, name and group. The stream URL is deliberately left out, since an
// Xtream link's token changes from one fetch to the next.
func channelID(sourceID, tvgID, name, group string) string {
	sum := sha256.Sum256([]byte(tvgID + "\x00" + name + "\x00" + group))
	return sourceID + ":" + hex.EncodeToString(sum[:])[:12]
}
