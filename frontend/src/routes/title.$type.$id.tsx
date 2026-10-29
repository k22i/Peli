import { createFileRoute } from "@tanstack/react-router";

import { TitlePage } from "@/components/title/title-page";
import { titleSearch } from "@/lib/title";

export const Route = createFileRoute("/title/$type/$id")({
  validateSearch: titleSearch,
  component: TitlePage,
});
