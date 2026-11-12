import { Browser } from "@wailsio/runtime";

import { Service as AppInfo } from "@bindings/appinfo";
import { isIOS } from "@/lib/platform";

// Opens a web page outside the app: the default browser, or Safari on iOS.
// The runtime's Browser.OpenURL runs `open` in a child process, which the iOS
// app can't, so there it goes through Go (appinfo.Service.OpenURL).
export function openURL(url: string): Promise<void> {
  return isIOS() ? AppInfo.OpenURL(url) : Browser.OpenURL(url);
}
