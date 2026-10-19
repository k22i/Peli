import { queryOptions } from "@tanstack/react-query";

import { Service as AppInfo } from "@bindings/appinfo";

// The version cannot change while the app runs.
export const appVersionQuery = queryOptions({
  queryKey: ["app-info", "version"],
  queryFn: () => AppInfo.Version(),
  staleTime: Number.POSITIVE_INFINITY,
});
