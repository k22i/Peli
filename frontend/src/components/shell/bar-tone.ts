import { useEffect, useSyncExternalStore } from "react";

// Whether a full-bleed hero sits under the top bar right now. While one
// does (and the page is at rest), the bar sets its text light over the art
// with a soft scrim, whatever the theme; once the page scrolls, it takes its
// usual material.
let heroes = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Called by a hero that bleeds under the bar, for as long as it's mounted.
export function useArtUnderBar(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    heroes += 1;
    emit();
    return () => {
      heroes -= 1;
      emit();
    };
  }, [active]);
}

export function useBarOverArt(): boolean {
  return useSyncExternalStore(subscribe, () => heroes > 0);
}
