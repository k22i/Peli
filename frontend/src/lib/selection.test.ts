import { describe, expect, it } from "vite-plus/test";

import { clickKind, selectRange, toggleKey } from "@/lib/selection";

const keys = ["a", "b", "c", "d", "e"];
const none = { metaKey: false, ctrlKey: false, shiftKey: false };

describe("selection", () => {
  it("takes the range between the anchor and the target, either way round", () => {
    expect(selectRange(keys, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectRange(keys, "d", "b")).toEqual(["b", "c", "d"]);
    expect(selectRange(keys, "c", "c")).toEqual(["c"]);
  });

  it("falls back to the target when the anchor is gone or unset", () => {
    expect(selectRange(keys, undefined, "c")).toEqual(["c"]);
    expect(selectRange(keys, "z", "c")).toEqual(["c"]);
    expect(selectRange(keys, "a", "z")).toEqual([]);
  });

  it("toggles a key without touching the set it was given", () => {
    const first = new Set(["a"]);
    expect([...toggleKey(first, "b")]).toEqual(["a", "b"]);
    expect([...toggleKey(first, "a")]).toEqual([]);
    expect([...first]).toEqual(["a"]);
  });

  it("reads a click: modifiers build the selection, a plain click opens until one exists", () => {
    expect(clickKind(none, false)).toBe("open");
    expect(clickKind(none, true)).toBe("toggle");
    expect(clickKind({ ...none, metaKey: true }, false)).toBe("toggle");
    expect(clickKind({ ...none, ctrlKey: true }, false)).toBe("toggle");
    expect(clickKind({ ...none, shiftKey: true }, false)).toBe("range");
  });
});
