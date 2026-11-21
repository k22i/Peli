//go:build !ios

package player

// insetRatio is mpv's video-margin-ratio-right for a right inset of
// rightPx CSS pixels in a window widthPx wide: the share of the width the
// picture leaves free, clamped to 0–maxInsetRatio. Zero when either is
// unknown. Both builds use it (the docked watch party's sidebar).
func insetRatio(rightPx, widthPx int) float64 {
	if rightPx <= 0 || widthPx <= 0 {
		return 0
	}
	return min(float64(rightPx)/float64(widthPx), maxInsetRatio)
}

// maxInsetRatio keeps some picture on screen however narrow the window.
const maxInsetRatio = 0.6
