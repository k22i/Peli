import { PosterCard, type CardProps } from "@/components/media/cards";
import type { LoadedAddon } from "@/lib/addon-protocol";
import { useAnimePoster } from "@/lib/anime-posters";

// A poster card on the Anime tab: the profile's poster addon's art when the
// entry is one title to it, with AniList's cover under it while that loads
// or if it fails, else AniList's cover alone.
export function AnimePosterCard({
  id,
  posterAddon,
  src,
  ...props
}: CardProps & { id: string; posterAddon: LoadedAddon | undefined }) {
  const poster = useAnimePoster(posterAddon, id);
  return <PosterCard {...props} src={poster ?? src} fallbackSrc={poster ? src : undefined} />;
}
