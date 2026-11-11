import type { Person } from "@/lib/tmdb";

// A person's name wherever TMDB names one. A plain element for now; it keeps
// the TMDB id so people can become links without touching its callers.
export function PersonLink({ person }: { person: Person }) {
  return <span data-person-id={person.id}>{person.name}</span>;
}
