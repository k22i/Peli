import { Artwork } from "@/components/media/artwork";
import { ScrollRail } from "@/components/media/scroll-rail";
import type { CastMember } from "@/lib/tmdb";

// The cast with their photos, from TMDB (#47): a short strip on a rail, with
// arrows and fades (#116, #117). Twenty people at most, so it isn't
// virtualized.
export function CastList({ cast }: { cast: CastMember[] }) {
  return (
    <section aria-labelledby="cast" className="flex flex-col gap-2">
      <h2 id="cast" className="px-page font-display text-[2.25rem] leading-none">
        Cast
      </h2>
      <ScrollRail>
        <ul aria-labelledby="cast" className="flex shrink-0 gap-3 py-3">
          {cast.map((person) => (
            <li key={person.id} className="flex w-28 shrink-0 flex-col items-center gap-2.5">
              <Artwork
                src={person.photo}
                use="avatar"
                title={person.name}
                className="aspect-square size-24 rounded-full shadow-card grayscale-[35%] transition-[filter] duration-(--duration-base) hover:grayscale-0"
              />
              <div className="flex w-full flex-col items-center text-center">
                <span className="line-clamp-2 text-small font-[590]">{person.name}</span>
                {person.character && (
                  <span className="line-clamp-2 text-small text-muted-foreground">
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
