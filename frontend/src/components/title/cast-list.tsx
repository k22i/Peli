import { Artwork } from "@/components/media/artwork";
import type { CastMember } from "@/lib/tmdb";

// The cast with their photos, from TMDB (#47): a short strip that scrolls
// sideways. Twenty people at most, so it isn't virtualized.
export function CastList({ cast }: { cast: CastMember[] }) {
  return (
    <section aria-labelledby="cast" className="flex flex-col gap-1">
      <h2 id="cast" className="px-gutter font-heading text-heading font-stretch-semi-expanded">
        Cast
      </h2>
      <ul
        aria-labelledby="cast"
        className="flex snap-x gap-4 scroll-px-gutter overflow-x-auto overscroll-x-contain px-gutter pt-3 pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {cast.map((person) => (
          <li key={person.id} className="flex w-28 shrink-0 snap-start flex-col items-center gap-2">
            <Artwork
              src={person.photo}
              title={person.name}
              className="aspect-square size-24 rounded-full shadow-lift"
            />
            <div className="flex w-full flex-col items-center text-center">
              <span className="line-clamp-2 text-sm font-medium">{person.name}</span>
              {person.character && (
                <span className="line-clamp-2 text-sm text-muted-foreground">
                  {person.character}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
