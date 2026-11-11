import { PosterCard } from "@/components/media/cards";
import { Row } from "@/components/media/row";
import { toastManager } from "@/components/ui/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useOpenTitle } from "@/lib/title";
import {
  tmdbImdbQuery,
  useTmdbCollection,
  useTmdbKey,
  type RelatedTitle,
  type TmdbArt,
} from "@/lib/tmdb";

// "Part of the X Collection" and "More Like This" (TMDB's suggestions). TMDB
// names its titles by TMDB id and Cinemeta only knows IMDb ids, so a card's
// IMDb id is looked up when it is opened (one small request, kept for a
// month) rather than for all twenty up front.
export function useOpenRelated() {
  const client = useQueryClient();
  const key = useTmdbKey();
  const open = useOpenTitle();
  return async (item: RelatedTitle) => {
    const imdb = key
      ? await client.fetchQuery(tmdbImdbQuery(key, item.media, item.tmdb)).catch(() => null)
      : null;
    if (!imdb) {
      toastManager.add({ type: "error", title: "Couldn’t open this title" });
      return;
    }
    open({
      id: imdb,
      type: item.media === "movie" ? "movie" : "series",
      name: item.title,
      poster: item.poster,
      releaseInfo: item.year,
    });
  };
}

function RelatedRow({
  title,
  items,
  current,
}: {
  title: string;
  items: RelatedTitle[];
  current?: number | undefined;
}) {
  const open = useOpenRelated();
  return (
    <Row
      title={title}
      items={items}
      getKey={(item) => `${item.media}:${item.tmdb}`}
      renderItem={(item) => (
        <PosterCard
          title={item.title}
          meta={item.tmdb === current ? "This film" : item.year}
          src={item.poster}
          aria-current={item.tmdb === current ? "page" : undefined}
          onClick={() => void open(item)}
        />
      )}
    />
  );
}

const collectionTitle = (name: string) =>
  `Part of the ${name.replace(/\s+Collection$/i, "")} Collection`;

// The page's last rows. Kids profiles get neither: TMDB's suggestions don't
// follow the profile's addon allow-list.
export function RelatedRows({ art }: { art: TmdbArt }) {
  const films = useTmdbCollection(art.collection);
  return (
    <>
      {art.collection && films && films.length > 1 && (
        <RelatedRow title={collectionTitle(art.collection.name)} items={films} current={art.id} />
      )}
      {art.related.length > 0 && <RelatedRow title="More Like This" items={art.related} />}
    </>
  );
}
