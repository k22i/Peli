import { useSyncExternalStore } from "react";

import { hardwareKeyboard, subscribeInputDevices } from "@/lib/input-devices";
import { isIOS } from "@/lib/platform";
import { regularWidthIOS, subscribeCompact } from "@/lib/shell-mode";
import { nativeTabBar } from "@/lib/tab-bar";

// The parts of Peli that are not in the iOS app (ADR-0055), and the few the
// iOS app alone has. One list, so a screen asks `feature("plugins")` instead
// of checking the platform, and the reason each is out is written down once.
//
// - updates, plugins and torrent are not bound on iOS (their Go packages are
//   not in the binary), so a call to one fails with "unknown bound method
//   id": every call site must skip, not catch.
// - watch parties (ADR-0051) used to be on this list; they are bound on iOS
//   now, like every desktop piece the party needs. A party trades only
//   play/pause/seek/chat over Nuvio's realtime channel, never video, so
//   nothing in it is the App Review problem that left it out of ADR-0055.
// - the rest are desktop window or mpv-only features, or out of scope.
export type Feature =
  | "updates"
  | "party"
  | "plugins"
  | "torrent"
  | "miniPlayer"
  | "playerPanels" // stats overlay, A–B loop, screenshots, the chapters menu
  | "hdr"
  // The picture controls the iOS player can't do. Its sheet and Settings ›
  // Playback are the same on both platforms; each of these hides one row
  // there, since the Go side doesn't apply them on iOS.
  | "framingFlips" // Mirror and Upside down: copies each frame off the GPU
  | "fillFit" // the Fill fit mode: on touch the pinch already fills the screen
  | "renderShaders" // sharpening and the upscalers (FSR, Anime4K)
  | "motionSmoothing" // blends frames in step with the screen, on a timer
  | "deinterlace" // the deinterlacer: the player there has none
  | "audioOutput" // the output devices (Player.AudioDevices) and their row
  | "volumeBoost" // "Volume up to 150 %": iOS's own volume goes no higher
  | "desktopControls" // fullscreen, the shortcuts list, a volume slider (iOS has the side buttons)
  | "streamSwitcher" // the player's Streams sheet
  | "commandPalette"
  | "people" // person pages
  | "multiSelect"
  | "gallery"
  | "downloadFolder" // choosing where downloads go: a folder dialog (#85)
  // The other way round, the iOS app alone has these:
  // - the native Liquid Glass tab bar (#129), from iOS 26 (UIGlassEffect);
  //   everywhere else TabBar draws its CSS capsule;
  // - downloads waiting for Wi-Fi (ADR-0064's `downloadsWiFiOnly`): mobile
  //   data is the phone's to answer for; a desktop has none.
  | "nativeTabBar"
  | "downloadsWiFiOnly";

const notOnIOS: ReadonlySet<Feature> = new Set<Feature>([
  "updates",
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
  // The phone downloads into its own sandbox, where there is no folder to
  // pick and no dialog to pick one: ChooseFolder is ErrUnsupported there.
  "downloadFolder",
  // The picture controls of the list above: the player and Settings show the
  // sheet without them.
  "framingFlips",
  "fillFit",
  "renderShaders",
  "motionSmoothing",
  "deinterlace",
  "audioOutput",
  "volumeBoost",
]);

// The other direction: what only iOS has. Asked before the list of what iOS
// lacks, since it is not about a part being missing.
const onlyOnIOS: ReadonlySet<Feature> = new Set<Feature>(["downloadsWiFiOnly"]);

// On an iPad some come back (#138):
// - with a hardware keyboard attached: the desktop shortcuts (and their
//   list) and ⌘K's palette, off again when it detaches;
// - at regular width: person pages, which work with touch and a pointer;
// - at regular width with a keyboard: the Library's multi-select, which is
//   ⌘/Shift-click and Space, with no touch way in.
const withKeyboard: ReadonlySet<Feature> = new Set<Feature>(["desktopControls", "commandPalette"]);

// Whether this build has the feature. Read when asked, not at import; a
// component that must follow a keyboard or a resize uses useFeature.
export function feature(name: Feature): boolean {
  if (name === "nativeTabBar") return isIOS() && nativeTabBar.available;
  if (onlyOnIOS.has(name)) return isIOS();
  if (!isIOS() || !notOnIOS.has(name)) return true;
  if (withKeyboard.has(name)) return hardwareKeyboard();
  if (name === "people") return regularWidthIOS();
  if (name === "multiSelect") return regularWidthIOS() && hardwareKeyboard();
  return false;
}

function subscribeFeatures(onChange: () => void): () => void {
  const stops = [subscribeInputDevices(onChange), subscribeCompact(onChange)];
  return () => {
    for (const stop of stops) stop();
  };
}

// feature(), re-rendering when a keyboard comes or goes or the window
// crosses the compact breakpoint.
export function useFeature(name: Feature): boolean {
  return useSyncExternalStore(
    subscribeFeatures,
    () => feature(name),
    () => feature(name),
  );
}
