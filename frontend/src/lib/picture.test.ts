import { describe, expect, it } from "vite-plus/test";

import { profileSettings } from "@/test/fixtures";

import {
  pictureOf,
  presetName,
  presetPicture,
  savePreset,
  signed,
  standardPicture,
  userPreset,
  withValue,
  maxNamedPictures,
  type NamedPicture,
} from "./picture";

const night: NamedPicture = {
  name: "Night",
  picture: { ...standardPicture, preset: "custom", brightness: -10 },
};

describe("pictureOf", () => {
  it("takes the title's own, then the profile's, then the file as it is", () => {
    const vivid = presetPicture("vivid")!;
    const cinema = presetPicture("cinema")!;
    const settings = profileSettings({ picture: cinema });
    expect(pictureOf(settings, { picture: vivid, changedAt: 1 })).toEqual(vivid);
    expect(pictureOf(settings, { changedAt: 1 })).toEqual(cinema);
    expect(pictureOf(settings, null)).toEqual(cinema);
    expect(pictureOf(undefined, undefined)).toEqual(standardPicture);
  });
});

describe("presetPicture", () => {
  it("gives a built-in preset's values, or one of the profile's own", () => {
    expect(presetPicture("standard")).toEqual(standardPicture);
    expect(presetPicture("vivid")?.saturation).toBeGreaterThan(0);
    expect(presetPicture(userPreset("Night"), [night])).toEqual({
      ...night.picture,
      preset: "user:Night",
    });
    expect(presetPicture("user:Gone", [night])).toBeUndefined();
    expect(presetPicture("custom")).toBeUndefined();
  });
});

describe("withValue", () => {
  it("turns a preset changed by hand into Custom", () => {
    const vivid = presetPicture("vivid")!;
    expect(withValue(vivid, { brightness: 5 })).toMatchObject({ preset: "custom", brightness: 5 });
    // Back to the preset's own values: still that preset.
    expect(withValue(vivid, { saturation: vivid.saturation })).toMatchObject({ preset: "vivid" });
    const own = presetPicture(userPreset("Night"), [night])!;
    expect(withValue(own, { shadowLift: true }, [night]).preset).toBe("custom");
  });
});

describe("savePreset", () => {
  it("adds a preset at the end, replaces one of the same name, and keeps to the cap", () => {
    const vivid = presetPicture("vivid")!;
    const added = savePreset([night], "  Bright ", vivid);
    expect(added?.map((each) => each.name)).toEqual(["Night", "Bright"]);
    expect(added?.[1]?.picture.preset).toBe("custom");
    expect(savePreset([night], "Night", vivid)?.[0]?.picture.saturation).toBe(vivid.saturation);
    expect(savePreset([night], "   ", vivid)).toBeUndefined();
    const full = Array.from({ length: maxNamedPictures }, (_, i) => ({ ...night, name: `P${i}` }));
    expect(savePreset(full, "One more", vivid)).toBeUndefined();
  });
});

describe("labels", () => {
  it("names presets and signs values", () => {
    expect(presetName("cinema")).toBe("Cinema");
    expect(presetName("custom")).toBe("Custom");
    expect(presetName("user:Night")).toBe("Night");
    expect([signed(8), signed(-4), signed(0)]).toEqual(["+8", "−4", "0"]);
  });
});
