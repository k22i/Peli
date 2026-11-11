import { formatTime } from "@/lib/player";

// The A–B loop (L, or More › A–B loop): mpv's ab-loop-a and ab-loop-b, set
// through Go's SetLoop. L sets A where playback is, then B, then clears
// both. A watch party refuses it (its jumps would pull this member out of
// step), so the player doesn't ask while the party watches the same thing.

export type Loop = { a?: number; b?: number };

// B this close after A, or before it, is a new A instead: a loop must play
// something.
const shortest = 0.5;

// What L does at position: the loop it leaves, and what to say.
export function nextLoop(loop: Loop, position: number): { loop: Loop; text: string } {
  const at = Math.max(0, position);
  if (loop.a !== undefined && loop.b !== undefined) return { loop: {}, text: "A–B loop off" };
  if (loop.a !== undefined && at >= loop.a + shortest) {
    return {
      loop: { a: loop.a, b: at },
      text: `Looping ${formatTime(loop.a)}–${formatTime(at)}`,
    };
  }
  return { loop: { a: at }, text: `Loop from ${formatTime(at)}, L again to end it` };
}

// The More menu's name for what L does next.
export function nextLoopLabel(loop: Loop): string {
  if (loop.a !== undefined && loop.b !== undefined) return "Clear A–B loop";
  if (loop.a !== undefined) return "End the loop here (B)";
  return "Start a loop here (A)";
}

// Go's SetLoop takes -1 for an end that isn't set.
export function loopArgs(loop: Loop): [number, number] {
  return [loop.a ?? -1, loop.b ?? -1];
}

// The loop in Go's state (null for an end that isn't set).
export function loopOf(state: { loopA?: number | null; loopB?: number | null }): Loop {
  return {
    ...(state.loopA != null && { a: state.loopA }),
    ...(state.loopB != null && { b: state.loopB }),
  };
}

export function sameLoop(a: Loop, b: Loop): boolean {
  return sameEnd(a.a, b.a) && sameEnd(a.b, b.b);
}

const sameEnd = (x?: number, y?: number) =>
  x === undefined || y === undefined ? x === y : Math.abs(x - y) < 0.05;
