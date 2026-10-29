import { createFileRoute } from "@tanstack/react-router";

import { LibraryPage } from "@/components/library/library-page";
import { librarySearch } from "@/lib/library";

export const Route = createFileRoute("/library")({
  validateSearch: librarySearch,
  component: LibraryPage,
});
