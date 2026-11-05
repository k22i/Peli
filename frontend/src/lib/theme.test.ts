import { describe, expect, it, vi } from "vite-plus/test";

import {
  readThemePreference,
  setThemePreference,
  startTheme,
  themeStorageKey,
  windowColours,
  type Theme,
} from "@/lib/theme";
import { indexCss as css } from "@/test/index-css";

// jsdom has no matchMedia; this stands in for the OS setting.
function mockColorScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    set(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

function start() {
  const root = document.createElement("html");
  const painted: Theme[] = [];
  const stop = startTheme(root, (theme) => painted.push(theme));
  return { root, painted, stop };
}

describe("startTheme", () => {
  it("follows the OS setting by default, until stopped", () => {
    const os = mockColorScheme(true);
    const { root, painted, stop } = start();
    expect(root).toHaveClass("dark");

    os.set(false);
    expect(root).not.toHaveClass("dark");
    expect(painted).toEqual(["dark", "light"]);

    stop();
    expect(os.listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it("lets the user override the OS, and go back to it", () => {
    const os = mockColorScheme(false);
    const { root, painted, stop } = start();

    setThemePreference("dark");
    expect(root).toHaveClass("dark");
    os.set(false);
    expect(root).toHaveClass("dark");

    setThemePreference("system");
    expect(root).not.toHaveClass("dark");
    expect(painted.at(-1)).toBe("light");

    stop();
    vi.unstubAllGlobals();
  });
});

describe("theme preference", () => {
  it("persists the choice and forgets it for System", () => {
    expect(readThemePreference()).toBe("system");

    setThemePreference("light");
    expect(localStorage.getItem(themeStorageKey)).toBe("light");
    expect(readThemePreference()).toBe("light");

    setThemePreference("system");
    expect(localStorage.getItem(themeStorageKey)).toBeNull();
  });

  it("ignores a stored value it doesn't know", () => {
    localStorage.setItem(themeStorageKey, "sepia");
    expect(readThemePreference()).toBe("system");
  });
});

describe("windowColours", () => {
  it("match the --background token in each mode", () => {
    const backgrounds = [...css.matchAll(/^\s+--background:\s*#([\da-f]{6});/gim)].map((match) =>
      [0, 2, 4].map((index) => Number.parseInt(match[1]!.slice(index, index + 2), 16)),
    );
    expect(backgrounds).toEqual([[...windowColours.light], [...windowColours.dark]]);
  });
});
