import { queryOptions } from "@tanstack/react-query";

import { Service as AppInfo } from "@bindings/appinfo";

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
