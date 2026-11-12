import { isIOS } from "@/lib/platform";

// The parts of Peli that are not in the iOS app (ADR-0055). One list, so a
// screen asks `feature("plugins")` instead of checking the platform, and the
// reason each is out is written down once.
//
// - updates, party, plugins and torrent are not bound on iOS (their Go
//   packages are not in the binary), so a call to one fails with "unknown
//   bound method id": every call site must skip, not catch.
// - the rest are desktop window or mpv-only features, or out of scope.
export type Feature =
  | "updates"
  | "party"
  | "plugins"
  | "torrent"
  | "miniPlayer"
  | "playerPanels" // picture, sound, quality, framing, stats, A–B loop, screenshots
  | "hdr"
  | "desktopControls" // fullscreen, the shortcuts list, a volume slider (iOS has the side buttons)
  | "streamSwitcher" // the player's Streams sheet
  | "commandPalette"
  | "people" // person pages
  | "multiSelect"
  | "gallery";

const notOnIOS: ReadonlySet<Feature> = new Set<Feature>([
  "updates",
  "party",
  "plugins",
  "torrent",
  "miniPlayer",
  "playerPanels",
  "hdr",
  "desktopControls",
  "streamSwitcher",
  "commandPalette",
  "people",
  "multiSelect",
  "gallery",
]);

// Whether this build has the feature. Read when asked, not at import.
export function feature(name: Feature): boolean {
  return !(isIOS() && notOnIOS.has(name));
}
