import { useSyncExternalStore } from "react";

// How many bottom sheets are open (#134). The compact shell hides its tab
// bar while any is (#129 reads `useSheetOpen()`; outside React,
// `sheetsOpen()` and `subscribeSheets()`). A count rather than a flag, since
// a sheet can open over another (a picker from a menu's page).
let open = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

// Marks a sheet open; call what it returns when it closes (or unmounts).
export function markSheetOpen(): () => void {
  open += 1;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    open -= 1;
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
