import { Browser } from "@wailsio/runtime";

import { Service as AppInfo } from "@bindings/appinfo";
import { isIOS } from "@/lib/platform";

// Opens a web page outside the app: the default browser, or Safari on iOS.
// The runtime's Browser.OpenURL runs `open` in a child process, which the iOS
// app can't, so there it goes through Go (appinfo.Service.OpenURL).
export function openURL(url: string): Promise<void> {
  return isIOS() ? AppInfo.OpenURL(url) : Browser.OpenURL(url);
}

// Opens a sign-in page whose redirect comes back to Peli itself (AniList's
// loopback page). On iOS it is a sheet over the app, which keeps the app in
// the foreground so the page can answer; Safari would suspend it first.
export function openSignInPage(url: string): Promise<void> {
  return isIOS() ? AppInfo.OpenSignInPage(url) : openURL(url);
}

// Dismisses the sheet openSignInPage showed. Nothing happens elsewhere.
export function closeSignInPage(): void {
  if (isIOS()) void AppInfo.CloseSignInPage();
}
