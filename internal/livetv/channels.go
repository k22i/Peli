package livetv

// ChannelsOf gives each entry of a playlist its Channel, in the same order
// (index i of the result is p.Entries[i]), with a stable ID (W1: TODO).
func ChannelsOf(sourceID string, p Playlist) []Channel {
	_ = sourceID
	return make([]Channel, 0, len(p.Entries))
}
