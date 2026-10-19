import { describe, expect, it, vi } from "vite-plus/test";

import { followSystemTheme } from "@/lib/theme";

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

describe("followSystemTheme", () => {
  it("toggles .dark with the OS setting until stopped", () => {
    const os = mockColorScheme(true);
    const root = document.createElement("html");

    const stop = followSystemTheme(root);
    expect(root).toHaveClass("dark");

    os.set(false);
    expect(root).not.toHaveClass("dark");

    stop();
    expect(os.listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
