import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shuffle } from "lucide-react";

import { PosterCard } from "@/components/media/cards";
import { Row } from "@/components/media/row";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { catalogQuery, type CatalogSource } from "@/lib/addon-protocol";
import {
  calendarShows,
  entryCode,
  recentDayLabel,
  recentEpisodes,
  type CalendarShow,
} from "@/lib/calendar";
import { useLoadedAddons } from "@/lib/home";
import { libraryPreview, libraryQuery } from "@/lib/library";
import { allWatchedQuery, surprise, watchedIds } from "@/lib/surprise";
import { cachedTitleMeta, titleMetaQuery, useOpenTitle } from "@/lib/title";
import { libraryMenuTitle, menuTitle } from "@/lib/title-actions";
import type { Profile } from "@bindings/store";

// Shows in the library with an episode out in the last week, newest first
// (Home, after Continue Watching). Details come from the title page's query,
// so shows seen before paint from the cache; nothing shows until one has an
// episode to offer, so a quiet week leaves no empty row.
export function NewEpisodes({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const open = useOpenTitle();
  const library = useQuery(libraryQuery(profile.id));
  const { addons, loading } = useLoadedAddons(profile.id);
  const shows = calendarShows(library.data ?? []);
  const details = useQueries({
    queries: shows.map((item) => ({
      ...titleMetaQuery(addons, item.contentType, item.contentId),
      enabled: !loading,
      ...cachedTitleMeta(client, addons, item.contentType, item.contentId),
    })),
  });
  const loaded = shows.flatMap((item, index): CalendarShow[] => {
    const meta = details[index]?.data?.meta;
    return meta ? [{ item, meta }] : [];
  });
  const entries = recentEpisodes(loaded);
  if (entries.length === 0) return null;
  return (
    <Row
      title="New episodes"
      items={entries}
      getKey={(entry) => `${entry.item.contentId}:${entry.item.contentType}`}
      renderItem={(entry) => (
        <PosterCard
          title={entry.item.name}
          meta={`${entryCode(entry)} · ${recentDayLabel(entry.airs)}`}
          src={entry.item.poster}
          menu={libraryMenuTitle(entry.item)}
          onClick={() => open(libraryPreview(entry.item), { season: entry.episode.season })}
        />
      )}
    />
  );
}

// Opens a random title you haven't watched: from the library, else from the
// first catalog on Home. The data is read when clicked, so it is fresh.
export function SurpriseButton({
  profileId,
  source,
}: {
  profileId: number;
  source: CatalogSource | undefined;
}) {
  const client = useQueryClient();
  const open = useOpenTitle();
  return (
    <Button
      size="xl"
      variant="media"
      className="ios-compact:px-4"
      onClick={async () => {
        try {
          const [library, marks, catalog] = await Promise.all([
            client.fetchQuery({ ...libraryQuery(profileId), staleTime: 0 }),
            client.fetchQuery({ ...allWatchedQuery(profileId), staleTime: 0 }),
            source
              ? client.ensureQueryData(
                  catalogQuery(source.addon.url, source.catalog.type, source.catalog.id),
                )
              : undefined,
          ]);
          const pick = surprise(library ?? [], catalog?.metas ?? [], watchedIds(marks ?? []));
          if (!pick) {
            toastManager.add({ type: "info", title: "Nothing new to suggest" });
          } else if (pick.from === "library") {
            open(libraryPreview(pick.item));
          } else {
            open(menuTitle(pick.meta));
          }
        } catch {
          toastManager.add({ type: "error", title: "Couldn’t pick a title" });
        }
      }}
    >
      <Shuffle />
      {/* A glyph on a phone: the hero's actions share one row. */}
      <span className="ios-compact:sr-only">Surprise me</span>
    </Button>
  );
}
