// A list row swiped left to show its Delete button, as in iOS lists (#137).
// Pure, so the rules are tested without a browser; the row component feeds
// it pointer positions. Distances are CSS px (UIKit points in the webview).

// Where a half-open row rests: the Delete button's width.
export const revealPx = 80;
// A swipe past this share of the row's width deletes it outright.
export const deleteFraction = 0.6;
// Movement before it counts as a swipe, so a tap or a vertical scroll isn't.
export const slopPx = 8;

export type SwipeEnd = "delete" | "open" | "close";

// The row's offset for a finger `dx` px from where it began, from rest at
// `from` (0 closed, -revealPx open): left only, a little rubber band past
// the row's width.
export function swipeOffset(from: number, dx: number, width: number): number {
  const raw = from + dx;
  if (raw >= 0) return 0;
  if (raw >= -width) return raw;
  return -width - Math.sqrt(-raw - width);
}

// What letting go does: a long swipe deletes, past half the button leaves it
// open, otherwise it closes. A fast flick left (px/s) counts as past half.
export function swipeEnd(offset: number, velocity: number, width: number): SwipeEnd {
  if (-offset > width * deleteFraction) return "delete";
  if (-offset > revealPx / 2 || velocity < -600) return "open";
  return "close";
}

export const restingOffset = (end: SwipeEnd, width: number): number =>
  end === "open" ? -revealPx : end === "delete" ? -width : 0;
