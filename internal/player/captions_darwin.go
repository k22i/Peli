//go:build darwin && !ios

package player

/*
#cgo LDFLAGS: -framework MediaAccessibility -framework CoreFoundation
#include <MediaAccessibility/MediaAccessibility.h>

// peliCaptions is 1 when System Settings > Accessibility > Captions asks
// for captions: "Prefer closed captions and SDH" (the preferred captioning
// characteristics then include transcribing dialogue), or a display type of
// always on, which apps such as TV set.
static int peliCaptions(void) {
	if (MACaptionAppearanceGetDisplayType(kMACaptionAppearanceDomainUser) == kMACaptionAppearanceDisplayTypeAlwaysOn)
		return 1;
	CFArrayRef prefs = MACaptionAppearanceCopyPreferredCaptioningMediaCharacteristics(kMACaptionAppearanceDomainUser);
	if (prefs == NULL)
		return 0;
	int on = CFArrayContainsValue(prefs, CFRangeMake(0, CFArrayGetCount(prefs)),
		CFSTR("public.accessibility.transcribes-spoken-dialog"));
	CFRelease(prefs);
	return on;
}
*/
import "C"

// osCaptions reads the user's captions preference from MediaAccessibility.
func osCaptions() bool { return C.peliCaptions() != 0 }
