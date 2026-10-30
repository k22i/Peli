//go:build !darwin

package player

// osCaptions is false: Windows' captions settings only style them, and
// Linux desktops have no such preference, so "system" means off there and
// the profile's On turns them on.
func osCaptions() bool { return false }
