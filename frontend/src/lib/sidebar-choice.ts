import { useSyncExternalStore } from "react";

// The iPad's choice at regular width (#138): the floating top capsule
// (false, the default) or the sidebar (true). Kept per device, in this
// webview's storage, as iPadOS apps keep their sidebar state; nothing else
// needs it, so it isn't synced or in the store.
const key = "peli.ipad-sidebar";

function read(): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

let shown: boolean | undefined;
const listeners = new Set<() => void>();

export function sidebarShown(): boolean {
  shown ??= read();
  return shown;
}

export function setSidebarShown(on: boolean) {
  if (sidebarShown() === on) return;
  shown = on;
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Private or blocked storage: the choice lasts this run.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSidebarShown(): boolean {
  return useSyncExternalStore(subscribe, sidebarShown, () => false);
}
