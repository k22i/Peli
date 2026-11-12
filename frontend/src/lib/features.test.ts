import { describe, expect, it } from "vite-plus/test";

import { feature, type Feature } from "@/lib/features";
import { onIOS } from "@/test/ios";

const outOnIOS: Feature[] = [
  "updates",
  "party",
  "plugins",
  "torrent",
  "miniPlayer",
  "playerPanels",
  "hdr",
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
});
