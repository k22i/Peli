//go:build !ios

package player

// The iOS touch player's native controls (#131): the screen's brightness,
// the system volume, the system chrome and the pinch's fill. The frontend
// only calls them on iOS (service_ios.go); the desktop binds the same
// methods, as no-ops, because the bindings come from this build.

// SetBrightness sets the screen's brightness, 0–1. Nothing on the desktop.
func (s *Service) SetBrightness(v float64) error { return nil }

// Brightness is the screen's brightness, 0–1, or -1 when the player can't
// read it (the desktop).
func (s *Service) Brightness() float64 { return -1 }

// SetSystemVolume sets the system volume, 0–1. Nothing on the desktop.
func (s *Service) SetSystemVolume(v float64) error { return nil }

// SystemVolume is the system volume, 0–1, or -1 when the player can't read
// it (the desktop).
func (s *Service) SystemVolume() float64 { return -1 }

// SetImmersive hides the status bar and home indicator. Nothing on the
// desktop.
func (s *Service) SetImmersive(on bool) error { return nil }

// SetPanscan crops the picture to fill the screen, 0–1. The desktop has
// Framing for that; nothing here.
func (s *Service) SetPanscan(v float64) error { return nil }
