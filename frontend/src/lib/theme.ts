import { Window } from "@wailsio/runtime";
import { useSyncExternalStore } from "react";

// Light or dark follows the OS unless the user picks one in Settings. coss ui
// styles dark mode from a `.dark` class on <html>; index.html's inline script
// sets it before first paint from the same stored choice, so keep the two in
// step.
export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];
export type Theme = "light" | "dark";

export const themeStorageKey = "peli.theme";

// The page colour (--background in index.css) for each mode. The content
// pane fills the window now, so this is what shows under the webview while
// resizing or a slow load, and never the other mode's colour. main.go starts
// with the OS's.
export const windowColours: Record<Theme, readonly [number, number, number]> = {
  light: [245, 242, 236],
  dark: [14, 13, 12],
};

const listeners = new Set<() => void>();

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return themePreferences.find((preference) => preference === stored) ?? "system";
  } catch {
    return "system";
  }
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(themeStorageKey);
    else localStorage.setItem(themeStorageKey, preference);
  } catch {
    // Storage can be unavailable; the choice then lasts for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, readThemePreference);
}

// The mode on screen now, after the OS setting. startTheme runs first (from
// main.tsx), so the class is already set when this re-renders.
export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      query.addEventListener("change", listener);
      const unsubscribe = subscribe(listener);
      return () => {
        query.removeEventListener("change", listener);
        unsubscribe();
      };
    },
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
  );
}

function paintNativeWindow(theme: Theme) {
  const [r, g, b] = windowColours[theme];
  // Rejects in a plain browser (tests, `vp dev`), where there is no window.
  Window.SetBackgroundColour(r, g, b, 255).catch(() => {});
}

// Paints the native window in the theme in use again: the player (#60)
// makes it transparent on Windows, so the video shows through.
export function repaintWindow() {
  paintNativeWindow(document.documentElement.classList.contains("dark") ? "dark" : "light");
}

// Applies the preference now and whenever it or the OS setting changes.
export function startTheme(
  root: HTMLElement = document.documentElement,
  paintWindow: (theme: Theme) => void = paintNativeWindow,
) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const preference = readThemePreference();
    const theme: Theme = preference === "system" ? (query.matches ? "dark" : "light") : preference;
    root.classList.toggle("dark", theme === "dark");
    paintWindow(theme);
  };

  apply();
  query.addEventListener("change", apply);
  const unsubscribe = subscribe(apply);
  return () => {
    query.removeEventListener("change", apply);
    unsubscribe();
  };
}
