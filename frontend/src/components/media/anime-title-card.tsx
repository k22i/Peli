import { PosterCard } from "@/components/media/cards";
import type { LoadedAddon, MetaPreview } from "@/lib/addon-protocol";
import { useAnimeCard } from "@/lib/anime-titles";
import { useOpenTitle } from "@/lib/title";
import { menuTitle } from "@/lib/title-actions";

// A poster card for an Anime tab entry (lib/anime-titles.ts): a followed one
// shows the poster addon's poster, name and year, with AniList's cover under
// it while that loads or if it fails, and opens the IMDb title, on the
// entry's season when it's a later one. Any other card as it is.
export function AnimeTitleCard({
  meta,
  posterAddon,
  onOpen,
}: {
  meta: MetaPreview;
  posterAddon: LoadedAddon | undefined;
  // Before the title opens: search keeps the term.
  onOpen?: () => void;
}) {
  const open = useOpenTitle();
  const { shown, fallbackSrc, search } = useAnimeCard(posterAddon, meta);
  return (
    <PosterCard
      title={shown.name}
      meta={shown.releaseInfo}
      src={shown.poster}
      fallbackSrc={fallbackSrc}
      menu={menuTitle(shown)}
      onClick={() => {
        onOpen?.();
        open(shown, search);
      }}
    />
  );
}
