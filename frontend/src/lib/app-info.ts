import { queryOptions } from "@tanstack/react-query";

import { Service as AppInfo } from "@bindings/appinfo";

import { isIOS } from "@/lib/platform";

// On iOS the webview stays clear from launch (no white flash) until the page
// reports it has started; Go also shows it after a few seconds regardless.
export function reportPageReady() {
  if (!isIOS()) return;
  const report = () => void AppInfo.PageReady().catch(() => {});
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", report, { once: true });
  } else {
    report();
  }
}

// The build number on iOS (CFBundleVersion), "" on a desktop.
export const appBuildQuery = queryOptions({
  queryKey: ["app-info", "build"],
  queryFn: () => AppInfo.Build(),
  staleTime: Number.POSITIVE_INFINITY,
});

// The version cannot change while the app runs.
export const appVersionQuery = queryOptions({
  queryKey: ["app-info", "version"],
  queryFn: () => AppInfo.Version(),
  staleTime: Number.POSITIVE_INFINITY,
});
