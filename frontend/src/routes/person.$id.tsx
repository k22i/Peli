import { createFileRoute } from "@tanstack/react-router";

import { PersonPage } from "@/components/title/person-page";

export const Route = createFileRoute("/person/$id")({
  component: PersonPage,
});
