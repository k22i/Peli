import { describe, expect, it } from "vite-plus/test";

import { profileSettings } from "@/test/fixtures";

import {
  cropSummary,
  cycle,
  defaultFraming,
  framingOf,
  noCrop,
  panBy,
  unzoomed,
  validAspect,
  zoomBy,
  zoomLabel,
} from "./framing";

describe("framingOf", () => {
  it("takes the title's own, else the profile's fit and auto-crop", () => {
    const own = { ...defaultFraming, aspect: "2.39:1", zoom: 0.5 };
    const settings = profileSettings({
      framing: { ...defaultFraming, fit: "fill", autoCrop: true, zoom: 1 },
    });
    expect(framingOf(settings, { framing: own, changedAt: 1 })).toEqual(own);
    expect(framingOf(settings, null)).toEqual({ ...defaultFraming, fit: "fill", autoCrop: true });
    expect(framingOf(undefined, undefined)).toEqual(defaultFraming);
  });
});

describe("zoom and pan", () => {
  it("zooms in quarter steps within bounds, and centres at 1×", () => {
    const zoomed = zoomBy(defaultFraming, 2);
    expect(zoomed.zoom).toBe(0.5);
    expect(zoomBy({ ...defaultFraming, zoom: 1.9 }, 1).zoom).toBe(2);
    const panned = panBy(zoomed, 0.3, -0.2);
    expect(zoomBy(panned, -2)).toMatchObject({ zoom: 0, panX: 0, panY: 0 });
    expect(panBy(panned, 5, 0).panX).toBe(1);
    expect(unzoomed({ ...panned, crop: { ...noCrop, top: 10 } })).toMatchObject({
      zoom: 0,
      panX: 0,
      crop: { top: 10 },
    });
    expect([zoomLabel(0), zoomLabel(0.5), zoomLabel(-1)]).toEqual(["1×", "1.41×", "0.5×"]);
  });
});

describe("validAspect", () => {
  it("takes W:H of two numbers above zero", () => {
    expect(["2.76:1", "12:5", "4:3"].every(validAspect)).toBe(true);
    expect(["0:9", "wide", "2.76", "123:1"].some(validAspect)).toBe(false);
  });
});

describe("cycle and cropSummary", () => {
  it("cycles round, and says what was cut", () => {
    expect(cycle(["fit", "fill"], "fill")).toBe("fit");
    expect(cycle(["fit", "fill"], "gone")).toBe("fit");
    expect(cropSummary({ ...noCrop, top: 12.6, bottom: 12.6 })).toBe("12.6 % top and bottom");
    expect(cropSummary({ top: 1, bottom: 2, left: 5, right: 5 })).toBe(
      "1 % top, 2 % bottom, 5 % each side",
    );
  });
});
