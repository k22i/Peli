import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { feature } from "@/lib/features";
import type { Person } from "@/lib/tmdb";
import { cn } from "@/lib/utils";

// A person's name wherever TMDB names one: a link to their page. Keeps the
// TMDB id on the element too. `decorative` is for a second link to the same
// page (a photo beside the name), left out of the Tab order and the
// accessibility tree so the name is the one stop.
export function PersonLink({
  person,
  decorative = false,
  className,
  children,
}: {
  person: Person;
  decorative?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  // No person pages on iOS (ADR-0055): the name is text.
  if (!feature("people")) {
    return <span className={className}>{children ?? person.name}</span>;
  }
  return (
    <Link
      to="/person/$id"
      params={{ id: String(person.id) }}
      data-person-id={person.id}
      {...(decorative && { tabIndex: -1, "aria-hidden": true })}
      className={cn(
        "rounded-xs outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      {children ?? person.name}
    </Link>
  );
}
