import { describe, expect, it, vi } from "vite-plus/test";

import { startTheme, themeStorageKey, windowColour } from "@/lib/theme";
import { indexCss as css } from "@/test/index-css";

// Peli is dark only (#143): there is no preference to read or set, and
// startTheme puts the dark class on <html> whatever the OS or an old build
// stored.
describe("startTheme", () => {
  it("sets the dark class and paints the window once", () => {
    const root = document.createElement("html");
    const paint = vi.fn<() => void>();

    startTheme(root, paint);

    expect(root).toHaveClass("dark");
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("reads an old light or system choice as dark, and clears it", () => {
    const root = document.createElement("html");
    localStorage.setItem(themeStorageKey, "light");

    startTheme(root, () => {});

    expect(root).toHaveClass("dark");
    expect(localStorage.getItem(themeStorageKey)).toBeNull();
  });
});

describe("windowColour", () => {
  it("matches the --background token", () => {
    const match = /^:root \{[\s\S]*?^\s+--background:\s*#([\da-f]{6});/im.exec(css);
    expect(match).not.toBeNull();
    const background = [0, 2, 4].map((index) =>
      Number.parseInt(match![1]!.slice(index, index + 2), 16),
    );
    expect(background).toEqual([...windowColour]);
  });
});
