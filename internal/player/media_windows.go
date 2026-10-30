package player

// newMediaControls: none of our own. libmpv runs the System Media Transport
// Controls itself with media-controls=yes (windowsHost.configure), naming
// what plays by media-title (SetNowPlaying) and setting pause and time-pos
// on the buttons, which come back as player:state like the screen's own.
func newMediaControls(func(mediaCommand, float64)) mediaControls { return nil }
