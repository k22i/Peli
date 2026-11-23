import { describe, expect, it } from "vite-plus/test";

import { feature, type Feature } from "@/lib/features";
import { nativeTabBar } from "@/lib/tab-bar";
import { onCompactIOS, onIOS } from "@/test/ios";

const outOnIOS: Feature[] = [
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
  "downloadFolder",
  // The picture controls the iOS player can't do.
  "framingFlips",
  "autoCrop",
  "fillFit",
  "renderShaders",
  "motionSmoothing",
  "deinterlace",
  "audioOutput",
  "volumeBoost",
];

describe("feature", () => {
  it("has everything on desktop", () => {
    expect(outOnIOS.filter((name) => !feature(name))).toEqual([]);
  });

  it("leaves out what the iOS app doesn't have, on an iPhone", () => {
    const restore = onCompactIOS();
    try {
      expect(outOnIOS.filter((name) => feature(name))).toEqual([]);
    } finally {
      restore();
    }
  });

  // Watch parties (ADR-0051) are in the iOS app now (ADR-0063), at both widths.
  it("has watch parties on an iPhone and an iPad", () => {
    onIOS();
    expect(feature("party")).toBe(true);
    const restore = onCompactIOS();
    try {
      expect(feature("party")).toBe(true);
    } finally {
      restore();
    }
  });

  it("brings person pages back on an iPad at regular width (#138)", () => {
    onIOS();
    expect(feature("people")).toBe(true);
    expect(outOnIOS.filter((name) => name !== "people" && feature(name))).toEqual([]);
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

  // The other way round (#85, ADR-0064): only the phone waits for Wi-Fi, as
  // its Downloads settings row is the one place that setting is offered.
  it("has Wi-Fi-only downloads on an iPhone and an iPad, not a desktop", () => {
    expect(feature("downloadsWiFiOnly")).toBe(false);
    onIOS();
    expect(feature("downloadsWiFiOnly")).toBe(true);
    const restore = onCompactIOS();
    try {
      expect(feature("downloadsWiFiOnly")).toBe(true);
    } finally {
      restore();
    }
  });
});
