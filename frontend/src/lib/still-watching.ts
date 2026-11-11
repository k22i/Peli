import { useEffect, useRef, type RefObject } from "react";

// "Still watching?": after the profile's number of episodes in a row
// (ProfileSettings.stillWatchingAfter, 0 for never) with no key or pointer
// input in between, the player asks rather than playing the next one.

export const defaultStillWatchingAfter = 3;

// The profile setting's choices, for Settings.
export const stillWatchingChoices = [0, 2, 3, 4, 5] as const;

// Whether to ask as an episode ends by itself and the next would start:
// `played` is how many started by themselves since the last input, so the
// one ending makes one more in a row.
export function stillWatchingDue(after: number | undefined, played: number): boolean {
  const limit = after ?? defaultStillWatchingAfter;
  return limit > 0 && played + 1 >= limit;
}

// How many episodes have started by themselves since the last key or
// pointer input: any input sets it back to 0. The player screen bumps it
// each time the next episode starts at the end of one.
export function useEpisodesWithoutInput(): RefObject<number> {
  const played = useRef(0);
  useEffect(() => {
    const reset = () => {
      played.current = 0;
    };
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const name of events)
      window.addEventListener(name, reset, { capture: true, passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, reset, { capture: true });
    };
  }, []);
  return played;
}
