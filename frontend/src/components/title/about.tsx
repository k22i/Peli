import type { ReactNode } from "react";

import type { Meta } from "@/lib/addon-protocol";
import { PersonLink } from "@/components/title/person-link";
import type { Person, TmdbArt } from "@/lib/tmdb";

const names = (people: Person[]): ReactNode =>
  people.map((person, index) => (
    <span key={person.id}>
      {index > 0 && ", "}
      <PersonLink person={person} />
    </span>
  ));

// The synopsis beside an information card (#117): cast and crew as the addon
// names them. The cast has its own strip, with photos, when TMDB lists it
// (#47). Two columns from `lg`, stacked below.
export function About({
  meta,
  withCast,
  art,
}: {
  meta: Meta;
  withCast: boolean;
  art?: TmdbArt | undefined;
}) {
  // TMDB's crew, with ids, where it has any; else the addon's plain names.
  const crew = art?.crew ?? [];
  const tmdbRows = crew.map(({ label, people }) => [label, names(people)] as const);
  const addonRows =
    crew.length > 0
      ? []
      : ([
          ["Directed by", meta.director],
          ["Written by", meta.writer],
        ] as const);
  const rows = [
    ["Cast", withCast ? meta.cast?.join(", ") : undefined] as const,
    ...tmdbRows,
    ...addonRows.map(([label, values]) => [label, values?.join(", ")] as const),
    ["Genres", meta.genres?.join(", ")] as const,
    ["Country", meta.country] as const,
    ["Network", art?.networks.join(", ")] as const,
    ["Studio", art?.studios.join(", ")] as const,
    ["Awards", meta.awards] as const,
  ].flatMap(([label, value]) => (value ? [{ label, value }] : []));
  if (rows.length === 0 && !meta.description) return null;
  return (
    <section aria-labelledby="about" className="flex flex-col gap-4 px-page">
      <h2 id="about" className="font-display text-[2.25rem] leading-none">
        About
      </h2>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)] lg:gap-12">
        {meta.description && (
          <p
            data-selectable
            className="max-w-prose text-[0.9375rem] leading-relaxed text-pretty text-foreground/80"
          >
            {meta.description}
          </p>
        )}
        {rows.length > 0 && (
          <dl
            className={`flex flex-col gap-4 rounded-2xl bg-card p-5 hairline ${meta.description ? "lg:col-start-2" : ""}`}
          >
            {rows.map(({ label, value }) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="type-eyebrow text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
