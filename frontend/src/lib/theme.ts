import { Window } from "@wailsio/runtime";

// Peli is dark only (#143), whatever the OS appearance. coss ui styles its
// dark variants from a `.dark` class on <html>; index.html sets it before
// first paint and startTheme keeps it there, and index.css's :root holds the
// dark tokens too, so nothing depends on the class for colour.
export const themeStorageKey = "peli.theme";

// The page colour (--background in index.css). The content pane fills the
// window, so this is what shows under the webview while resizing or a slow
// load. main.go and internal/iosplayer use the same colour.
export const windowColour: readonly [number, number, number] = [14, 13, 12];

// The iOS player draws its video in a native view under the webview
// (ADR-0058), so the window has to stay clear while that screen is up: a
// theme paint then (the page finishing its start) made the webview opaque
// again and hid the picture.
let keptClear = false;

// Clears the window until the returned function is called; the player's
// repaintWindow after Stop paints it again.
export function keepWindowClear(): () => void {
  keptClear = true;
  Window.SetBackgroundColour(0, 0, 0, 0).catch(() => {});
  return () => {
    keptClear = false;
  };
}

function paintNativeWindow() {
  if (keptClear) return;
  const [r, g, b] = windowColour;
  // Rejects in a plain browser (tests, `vp dev`), where there is no window.
  Window.SetBackgroundColour(r, g, b, 255).catch(() => {});
}

// Paints the native window in Peli's colour again: the player (#60) makes it
// transparent on Windows, so the video shows through.
export function repaintWindow() {
  paintNativeWindow();
}

// Sets the dark class and paints the window. An old "light" or "system"
// choice stored by an earlier build is read as dark and cleared.
export function startTheme(
  root: HTMLElement = document.documentElement,
  paintWindow: () => void = paintNativeWindow,
) {
  try {
    localStorage.removeItem(themeStorageKey);
  } catch {
    // Storage can be unavailable; there is nothing to clear then.
  }
  root.classList.add("dark");
  paintWindow();
}
