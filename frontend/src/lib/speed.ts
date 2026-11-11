// Playback speed: the steps the Speed menu offers and [ and ] move through,
// within Go's SetSpeed range (0.25–4). Every file starts at 1× (Go resets
// it at Load); a watch party's gate may refuse a change.

export const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;

export const normalSpeed = 1;

// The step after (by 1) or before (by -1) speed, held at the ends. A speed
// between steps (a watch party's small correction) goes to the next one
// that way.
export function stepSpeed(speed: number, by: 1 | -1): number {
  if (by > 0) return speeds.find((each) => each > speed + 0.001) ?? speeds.at(-1)!;
  return speeds.findLast((each) => each < speed - 0.001) ?? speeds[0];
}

// "1×", "1.25×", "0.5×".
export function speedLabel(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}

// Whether speed is the step to show as picked, with a watch party's
// nudges (1.03×) counting as the step they're near.
export function sameSpeed(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.06;
}
