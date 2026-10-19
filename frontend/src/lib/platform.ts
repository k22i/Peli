import { System } from "@wailsio/runtime";

export type Platform = "mac" | "windows" | "linux" | "browser";

// The OS the Wails runtime reports. "browser" covers tests and `vp dev` in a
// plain browser, where there is no native window to decorate.
export function currentPlatform(): Platform {
  if (System.IsMac()) return "mac";
  if (System.IsWindows()) return "windows";
  if (System.IsLinux()) return "linux";
  return "browser";
}
