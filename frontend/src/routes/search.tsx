import { createFileRoute } from "@tanstack/react-router";

import { SearchPage } from "@/components/search/search-page";
import { searchSearch } from "@/lib/search";

export const Route = createFileRoute("/search")({
  validateSearch: searchSearch,
  component: SearchPage,
});
