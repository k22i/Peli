import { queryOptions } from "@tanstack/react-query";

import { Service as Licences } from "@bindings/licences";

// The notices are embedded in the binary: they cannot change while the app runs.
export const noticesQuery = queryOptions({
  queryKey: ["licences", "notices"],
  queryFn: () => Licences.Notices(),
  staleTime: Number.POSITIVE_INFINITY,
});
