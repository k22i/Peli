import { describe, expect, it } from "vite-plus/test";

import { feature, type Feature } from "@/lib/features";
import { nativeTabBar } from "@/lib/tab-bar";
import { onIOS } from "@/test/ios";

const outOnIOS: Feature[] = [
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
];

describe("feature", () => {
  it("has everything on desktop", () => {
    expect(outOnIOS.filter((name) => !feature(name))).toEqual([]);
  });

  it("leaves out what the iOS app doesn't have", () => {
    onIOS();
    expect(outOnIOS.filter((name) => feature(name))).toEqual([]);
  });

  it("has the native tab bar only on iOS, once the app found one", () => {
    nativeTabBar.available = true;
    try {
      expect(feature("nativeTabBar")).toBe(false);
      onIOS();
      expect(feature("nativeTabBar")).toBe(true);
      nativeTabBar.available = false;
      expect(feature("nativeTabBar")).toBe(false);
    } finally {
      nativeTabBar.available = false;
    }
  });
});
