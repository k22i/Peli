import { describe, expect, it } from "vite-plus/test";

import { heroArrowStep } from "@/lib/marquee";

const key = (name: string, extra: Partial<KeyboardEventInit> & { target?: EventTarget } = {}) => ({
  key: name,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: null,
  ...extra,
});

describe("heroArrowStep", () => {
  it("pages back with ← and on with →", () => {
    expect(heroArrowStep(key("ArrowLeft"), 5)).toBe(-1);
    expect(heroArrowStep(key("ArrowRight"), 5)).toBe(1);
  });

  it("leaves other keys alone", () => {
    expect(heroArrowStep(key("ArrowDown"), 5)).toBe(0);
    expect(heroArrowStep(key("Enter"), 5)).toBe(0);
  });

  it("doesn't page one title", () => {
    expect(heroArrowStep(key("ArrowRight"), 1)).toBe(0);
  });

  it("leaves modified arrows and handled keys alone", () => {
    expect(heroArrowStep(key("ArrowRight", { metaKey: true }), 5)).toBe(0);
    expect(heroArrowStep(key("ArrowRight", { shiftKey: true }), 5)).toBe(0);
    expect(heroArrowStep({ ...key("ArrowRight"), defaultPrevented: true }, 5)).toBe(0);
  });

  it("leaves a text field its arrows", () => {
    const input = document.createElement("input");
    expect(heroArrowStep(key("ArrowLeft", { target: input }), 5)).toBe(0);
  });
});
