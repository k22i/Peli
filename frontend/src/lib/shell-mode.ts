import { useSyncExternalStore } from "react";

import { isIOS } from "@/lib/platform";

// The shell has two shapes on iOS (ADR-0055): the top bar with the sections
// in it at regular width (an iPad full screen or in a wide split view), and
// a bottom tab bar at compact width (an iPhone upright, an iPad in a narrow
// split view or Slide Over). It follows the window, not the device, so a
// split-view resize switches it live. An iPhone on its side is wide but only
// ~390 pt tall: it takes the tab bar too, as UIKit's compact height does.
// Desktop never takes it: a narrow desktop window keeps the top bar.
export const compactQuery = "(max-width: 699.98px), (max-height: 499.98px)";

function subscribe(onChange: () => void) {
  if (typeof matchMedia !== "function") return () => {};
  const list = matchMedia(compactQuery);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

const snapshot = () => typeof matchMedia === "function" && matchMedia(compactQuery).matches;

// True when the iOS app is narrow (or short) enough for the tab bar.
export function useCompactShell(): boolean {
  const matches = useSyncExternalStore(subscribe, snapshot, () => false);
  return isIOS() && matches;
}
