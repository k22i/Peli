import { useEffect } from "react";

import { isIOS } from "@/lib/platform";

// The on-screen keyboard on iOS (#137). WKWebView doesn't resize the layout
// viewport for it: `window.innerHeight` stays full and `visualViewport`
// shrinks. So the page reads the keyboard's height from the difference and
// puts it in `--keyboard-h` on <html>; the content pane pads its bottom by it
// (app-shell.tsx), so the last row can scroll above the keyboard, and a
// full-height sheet pads its bottom by it too.

// Below this the visual viewport shrank for something else (a zoom, a
// collapsing bar), not the keyboard.
export const keyboardMinPx = 100;

type Viewport = { height: number; offsetTop: number };

// How much of the layout viewport the keyboard covers: the layout viewport's
// height less what the visual viewport shows, less how far it was panned
// down (the page shifts up when a field is focused), 0 when it's too little
// to be the keyboard.
export function keyboardInset(layoutHeight: number, viewport: Viewport): number {
  const covered = Math.round(layoutHeight - viewport.height - viewport.offsetTop);
  return covered >= keyboardMinPx ? covered : 0;
}

// A drag of the results that closes the keyboard, as in iOS lists: the touch
// has moved more than this from where it began.
export const dismissAfterPx = 10;

export function shouldDismissKeyboard(startY: number, y: number): boolean {
  return Math.abs(y - startY) > dismissAfterPx;
}

// Writes --keyboard-h for the app's lifetime (iOS only). When the keyboard
// goes away the layout viewport is put back at the top: WebKit can leave the
// page panned up after a dismiss, and the window should never scroll (the
// page scrolls in #content).
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!isIOS() || !viewport) return undefined;
    const root = document.documentElement;
    let before = 0;
    const update = () => {
      const inset = keyboardInset(window.innerHeight, viewport);
      root.style.setProperty("--keyboard-h", `${inset}px`);
      root.toggleAttribute("data-keyboard", inset > 0);
      if (before > 0 && inset === 0) window.scrollTo(0, 0);
      before = inset;
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--keyboard-h");
      root.removeAttribute("data-keyboard");
    };
  }, []);
}

// Closes the keyboard when the user starts to scroll `pane`: the first
// touchmove that passes 10 pt blurs the focused field. Passive: it never
// holds the scroll up.
export function useDismissKeyboardOnScroll(pane: HTMLElement | null, enabled: boolean) {
  useEffect(() => {
    if (!pane || !enabled) return undefined;
    let start: number | undefined;
    const onStart = (event: TouchEvent) => {
      start = event.touches[0]?.clientY;
    };
    const onMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (start === undefined || y === undefined || !shouldDismissKeyboard(start, y)) return;
      start = undefined;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
        active.blur();
    };
    pane.addEventListener("touchstart", onStart, { passive: true });
    pane.addEventListener("touchmove", onMove, { passive: true });
    return () => {
      pane.removeEventListener("touchstart", onStart);
      pane.removeEventListener("touchmove", onMove);
    };
  }, [pane, enabled]);
}

// iOS only opens the keyboard for a field focused inside a tap, and the
// Search page's field is focused once the route has rendered, a tick after.
// So the tap focuses a hidden field of its own first, which brings the
// keyboard up, and the page's field takes the focus from it with the keyboard
// staying. If nothing does, the hidden field lets go after a moment.
export function primeKeyboard() {
  if (!isIOS()) return;
  const input = document.createElement("input");
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  input.enterKeyHint = "search";
  input.autocapitalize = "off";
  input.setAttribute("autocorrect", "off");
  // 16 px, so WebKit doesn't zoom; clear of everything, and invisible.
  input.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none;";
  document.body.append(input);
  input.focus({ preventScroll: true });
  setTimeout(() => {
    if (document.activeElement === input) input.blur();
    input.remove();
  }, 1500);
}
