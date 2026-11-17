import { useSyncExternalStore } from "react";

import { hideTabBar } from "@/lib/tab-bar";

// How many bottom sheets are open (#134), for anything that wants to know
// (`useSheetOpen()`; outside React, `sheetsOpen()` and `subscribeSheets()`).
// A count rather than a flag, since a sheet can open over another. Each open
// sheet also holds a `hideTabBar()` request (#129), so both the native bar
// and the CSS capsule hide while it's up.
let open = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

// Marks a sheet open; call what it returns when it closes (or unmounts).
export function markSheetOpen(): () => void {
  open += 1;
  const showTabBar = hideTabBar();
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    open -= 1;
    showTabBar();
    emit();
  };
}

export function sheetsOpen(): number {
  return open;
}

export function subscribeSheets(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

// True while a bottom sheet is open.
export function useSheetOpen(): boolean {
  return useSyncExternalStore(
    subscribeSheets,
    () => open > 0,
    () => false,
  );
}
