import { describe, expect, it } from "vite-plus/test";

import {
  brightP90,
  isBright,
  isDarkLogo,
  regionTone,
  sampleUrl,
  toneGrid,
  type ToneGrid,
} from "./art-tone";

// A grid from one RGBA value per cell, row by row.
function grid(width: number, height: number, cell: (x: number, y: number) => number[]): ToneGrid {
  const data: number[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.push(...cell(x, y));
  return toneGrid(data, width, height);
}

const white = [255, 255, 255, 255];
const black = [0, 0, 0, 255];
const clear = [0, 0, 0, 0];

describe("sampleUrl", () => {
  it("asks the hosts for a small size", () => {
    expect(sampleUrl("https://image.tmdb.org/t/p/original/a.jpg", "backdrop")).toBe(
      "https://image.tmdb.org/t/p/w300/a.jpg",
    );
    expect(sampleUrl("https://image.tmdb.org/t/p/w500/a.png", "logo")).toBe(
      "https://image.tmdb.org/t/p/w185/a.png",
    );
    expect(sampleUrl("https://images.metahub.space/background/medium/tt1/img", "backdrop")).toBe(
      "https://images.metahub.space/background/small/tt1/img",
    );
    expect(sampleUrl("https://images.metahub.space/logo/medium/tt1/img", "logo")).toBe(
      "https://images.metahub.space/logo/medium/tt1/img",
    );
    expect(sampleUrl("https://media.kitsu.app/a.jpg", "backdrop")).toBe(
      "https://media.kitsu.app/a.jpg",
    );
  });
});

describe("regionTone", () => {
  // White on the left half, black on the right.
  const halves = grid(16, 9, (x) => (x < 8 ? white : black));

  it("reads only the region behind the text", () => {
    const left = regionTone(halves, { aspect: 16 / 9, x0: 0, x1: 0.5, y0: 0.4, y1: 1 });
    expect(left.mean).toBeCloseTo(1);
    const right = regionTone(halves, { aspect: 16 / 9, x0: 0.5, x1: 1, y0: 0, y1: 1 });
    expect(right.mean).toBeCloseTo(0);
  });

  it("follows object-cover cropping in a narrow box", () => {
    // A tall box shows the middle eighth of the width: the start of it is
    // still the white half, its end the black one.
    const box = { aspect: 2 / 9, y0: 0, y1: 1 };
    expect(regionTone(halves, { ...box, x0: 0, x1: 0.4 }).mean).toBeCloseTo(1);
    expect(regionTone(halves, { ...box, x0: 0.6, x1: 1 }).mean).toBeCloseTo(0);
  });
});

describe("isBright", () => {
  it("counts bright patches as well as a bright average", () => {
    expect(isBright({ mean: 0.5, p90: 0.7 })).toBe(true);
    expect(isBright({ mean: 0.1, p90: 0.8 })).toBe(true);
    expect(isBright({ mean: 0.05, p90: 0.2 })).toBe(false);
  });

  it("matches the dark-art contrast pair's colour", () => {
    // contrast.ts checks hero text over #cbcbcb as the brightest art read as dark.
    const cell = grid(1, 1, () => [0xcb, 0xcb, 0xcb, 255]).lum[0]!;
    expect(cell).toBeGreaterThanOrEqual(brightP90 - 0.01);
  });
});

describe("isDarkLogo", () => {
  it("finds near-black ink and ignores the transparent ground", () => {
    expect(isDarkLogo(grid(10, 4, (x) => (x < 3 ? black : clear)))).toBe(true);
    expect(isDarkLogo(grid(10, 4, (x) => (x < 3 ? white : clear)))).toBe(false);
    // A red logo reads on the shade as it is.
    expect(isDarkLogo(grid(10, 4, (x) => (x < 3 ? [196, 18, 47, 255] : clear)))).toBe(false);
    // Mostly light with a black outline.
    expect(isDarkLogo(grid(10, 4, (x) => (x === 0 ? black : x < 6 ? white : clear)))).toBe(false);
    expect(isDarkLogo(grid(4, 4, () => clear))).toBe(false);
  });
});
