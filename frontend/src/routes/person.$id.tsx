import { createFileRoute, redirect } from "@tanstack/react-router";

import { PersonPage } from "@/components/title/person-page";
import { feature } from "@/lib/features";

export const Route = createFileRoute("/person/$id")({
  // Not in the iOS app (ADR-0055).
  beforeLoad: () => {
    if (!feature("people")) throw redirect({ to: "/", replace: true });
  },
  component: PersonPage,
});
