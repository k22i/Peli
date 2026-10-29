import { createFileRoute } from "@tanstack/react-router";

import { BrowsePage } from "@/components/browse/browse-page";
import { browseSearch } from "@/lib/browse";

export const Route = createFileRoute("/anime")({
  validateSearch: browseSearch,
  component: () => <BrowsePage kind="anime" />,
});
