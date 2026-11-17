// Package haptics is the iOS app's taptic feedback (#131; #135 extends it).
//
// The Service is bound on every platform, because the frontend's bindings
// come from the desktop build and a bound method's id hashes its package,
// type and name (ADR-0055). Off iOS it does nothing.
package haptics

// The kinds of Impact, after UIKit's feedback generators.
const (
	// Light, Medium and Heavy are UIImpactFeedbackGenerator's styles.
	Light  = "light"
	Medium = "medium"
	Heavy  = "heavy"
	// Selection is UISelectionFeedbackGenerator's tick.
	Selection = "selection"
	// Success, Warning and Error are UINotificationFeedbackGenerator's
	// (#135): sign-in or pairing done, a wrong PIN, an error toast.
	Success = "success"
	Warning = "warning"
	Error   = "error"
)

// Service is the bound haptics API. The zero value is ready.
type Service struct{}

// Impact plays one tap of kind (Light, Medium, Heavy, Selection, Success,
// Warning or Error; anything else is Light). A no-op off iOS, on devices
// without a Taptic Engine, and when Settings › Sounds & Haptics › System
// Haptics is off (UIKit checks).
func (*Service) Impact(kind string) { impact(kind) }
