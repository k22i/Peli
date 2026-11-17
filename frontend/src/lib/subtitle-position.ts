import { useSyncExternalStore } from "react";

// Where subtitles sit, as the player draws them: mpv puts the main ones, and
// the screen draws the second line (dual subtitles) over the video, above them.
// Both follow the same few numbers, which are mpv's own at its 720-line
// reference height: a 55-pixel face and a 22-pixel margin below the text.

// How tall one line of the main subtitles is, and the margin under them, as
// shares of the window's height (at a size of 100 %).
const lineShare = 55 / 720;
const marginShare = 22 / 720;
// A line's height is a little more than its font size.
const leading = 1.15;

// The second line is drawn at this share of the main subtitles' size.
export const secondScale = 0.7;
// The gap between the second line and the main ones, in em of the second.
const secondGap = 0.25;

// How far the lift (Go's SubtitleStyle.Lift) and the size reach.
export const maxLift = 30;
export const minSize = 50;
export const maxSize = 200;
// One press of R or G.
export const liftStep = 2;
export const sizeStep = 5;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const nudgeLift = (lift: number, by: number) => clamp(Math.round(lift + by), 0, maxLift);
export const nudgeSize = (size: number, by: number) =>
  clamp(Math.round(size + by), minSize, maxSize);

// "At the bottom", "Raised 6 %".
export const liftText = (lift: number) => (lift === 0 ? "At the bottom" : `Raised ${lift} %`);

// How much of the window's bottom the controls cover, in rem: the dock's top
// edge and a gap. The mini player's dock is a smaller card.
const clearance = { full: 8, mini: 6.5 };

// The lift, in percent of the height, that has the main subtitles' last line
// clear of the controls: what the dock needs less the margin mpv leaves
// anyway, rounded up. It can't pass what a style can hold, so in a tiny
// window the subtitles end up as high as they go. `covers` is how many rem
// the controls take, where they aren't the dock's (the touch player's thin
// chrome, #130).
export function liftToClear(height: number, mini: boolean, rem = 16, covers?: number): number {
  if (height <= 0) return 0;
  const covered = ((covers ?? clearance[mini ? "mini" : "full"]) * rem) / height;
  return clamp(Math.ceil((covered - marginShare) * 100), 0, maxLift);
}

// The lift to draw with. While the controls show, the subtitles rise to
// clear them, unless the user's own lift is higher already: the two don't add
// up, so a lift set to clear the controls once doesn't leave the subtitles
// too high the rest of the time.
export function liftNow(lift: number, controlsShown: boolean, clear: number): number {
  return controlsShown ? Math.max(lift, clear) : lift;
}

// How many lines the main subtitles are showing.
export function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

// Where the second line goes and how big it is, in pixels of a window
// `height` tall: its bottom edge is above the main subtitles, which stand
// `lift` percent up and are `lines` lines of `size` percent tall. `base` is
// the size at 100 %, for subtitlePreviewStyle, which applies the style's size.
export function secondLine(
  height: number,
  { size, lift }: { size: number; lift: number },
  lines: number,
): { bottom: number; base: number } {
  const main = (lineShare * size) / 100;
  const second = height * main * secondScale;
  const bottom =
    height * (marginShare + lift / 100) + height * main * leading * lines + second * secondGap;
  return { bottom: Math.round(bottom), base: height * lineShare * secondScale };
}

const subscribe = (notify: () => void) => {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
};

// The window's height, kept up to date.
export function useWindowHeight(): number {
  return useSyncExternalStore(
    subscribe,
    () => window.innerHeight,
    () => 720,
  );
}
