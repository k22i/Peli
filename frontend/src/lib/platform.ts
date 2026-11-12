import { System } from "@wailsio/runtime";

export type Platform = "mac" | "windows" | "linux" | "ios" | "browser";

// The OS the Wails runtime reports. "browser" covers tests and `vp dev` in a
// plain browser, where there is no native window to decorate.
export function currentPlatform(): Platform {
  if (isIOS()) return "ios";
  if (System.IsMac()) return "mac";
  if (System.IsWindows()) return "windows";
  if (System.IsLinux()) return "linux";
  return "browser";
}

// Running as the iOS/iPadOS app (ADR-0055). A function, not a constant, so a
// test can flip it.
export function isIOS(): boolean {
  return System.IsIOS() || iosUserAgent.test(navigator.userAgent);
}

// Wails' runtime reads window._wails.environment to answer System.IsIOS(), but
// the iOS webview never injects it (3.1.0 does on desktop only), so the app
// names itself in the user agent instead (ApplicationNameForUserAgent in
// main_ios.go). Keep the two in step.
const iosUserAgent = /\bPeliIOS\b/;

// How the screens that talk about where things are kept name the device.
export function thisDevice(): string {
  return isIOS() ? "this device" : "this computer";
}

// Whether the only pointer is a finger: no hover, no right-click. Always on
// iOS; on a desktop touch screen with no mouse attached, too.
export function isTouch(): boolean {
  if (isIOS()) return true;
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(any-pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
}

// Marks <html> for CSS that differs by platform: data-platform="ios" and
// data-touch. Called once at startup.
export function startPlatform() {
  const root = document.documentElement;
  root.dataset["platform"] = currentPlatform();
  if (isTouch()) root.dataset["touch"] = "";
}
