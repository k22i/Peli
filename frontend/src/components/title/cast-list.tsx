import { Artwork } from "@/components/media/artwork";
import { ScrollRail } from "@/components/media/scroll-rail";
import type { CastMember } from "@/lib/tmdb";

// The cast with their photos, from TMDB (#47): a short strip on a rail, with
// arrows and fades (#116, #117). Twenty people at most, so it isn't
// virtualized.
export function CastList({ cast }: { cast: CastMember[] }) {
  return (
    <section aria-labelledby="cast" className="flex flex-col gap-2">
      <h2 id="cast" className="px-gutter text-heading">
        Cast
      </h2>
      <ScrollRail>
        <ul aria-labelledby="cast" className="flex shrink-0 gap-4 py-3">
          {cast.map((person) => (
            <li key={person.id} className="flex w-36 shrink-0 flex-col items-center gap-3">
              <Artwork
                src={person.photo}
                use="avatar"
                title={person.name}
                className="aspect-square size-32 rounded-full shadow-card"
              />
              <div className="flex w-full flex-col items-center text-center">
                <span className="line-clamp-2 text-card">{person.name}</span>
                {person.character && (
                  <span className="line-clamp-2 text-caption text-muted-foreground">
                    {person.character}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ScrollRail>
    </section>
  );
}
