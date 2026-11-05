import type { Meta } from "@/lib/addon-protocol";

// The synopsis beside an information card (#117): cast and crew as the addon
// names them. The cast has its own strip, with photos, when TMDB lists it
// (#47). Two columns from `lg`, stacked below.
export function About({ meta, withCast }: { meta: Meta; withCast: boolean }) {
  const rows = [
    ["Cast", withCast ? meta.cast : undefined],
    ["Directed by", meta.director],
    ["Written by", meta.writer],
    ["Genres", meta.genres],
    ["Country", meta.country ? [meta.country] : undefined],
    ["Awards", meta.awards ? [meta.awards] : undefined],
  ].flatMap(([label, values]) =>
    Array.isArray(values) && values.length > 0 ? [{ label: String(label), values }] : [],
  );
  if (rows.length === 0 && !meta.description) return null;
  return (
    <section aria-labelledby="about" className="flex flex-col gap-4 px-gutter">
      <h2 id="about" className="font-heading text-heading font-stretch-semi-expanded">
        About
      </h2>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)] lg:gap-12">
        {meta.description && (
          <p className="max-w-prose text-pretty text-muted-foreground">{meta.description}</p>
        )}
        {rows.length > 0 && (
          <dl
            className={`glass-thin flex flex-col gap-4 rounded-2xl p-5 ${meta.description ? "lg:col-start-2" : ""}`}
          >
            {rows.map(({ label, values }) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="text-meta font-medium tracking-[0.06em] text-muted-foreground uppercase">
                  {label}
                </dt>
                <dd>{values.join(", ")}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
