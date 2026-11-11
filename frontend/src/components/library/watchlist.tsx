import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bookmark, Unplug } from "lucide-react";

import { GridSkeleton } from "@/components/browse/browse-page";
import { LibraryNotice } from "@/components/library/notice";
import { PosterCard } from "@/components/media/cards";
import { PosterGrid } from "@/components/media/poster-grid";
import { Button, buttonVariants } from "@/components/ui/button";
import { connectedServices, trackingQuery, watchlistQuery } from "@/lib/tracking";
import { useOpenTitle, type TitlePreview } from "@/lib/title";
import { menuTitle } from "@/lib/title-actions";
import type { Profile } from "@bindings/store";
import type { WatchlistItem } from "@bindings/tracking";

// What the profile's connected lists have planned (SIMKL's Plan to watch,
// AniList's Planning), as the library's cards with the shared title menu, so
// Remove from Watchlist is a right-click away. The lists are theirs, not
// Sinag's: nothing here is kept on this device or sent to Nuvio.
export function Watchlist({ profile }: { profile: Profile }) {
  const connections = useQuery(trackingQuery(profile.id));
  const connected = connectedServices(connections.data).length > 0;
  const list = useQuery({ ...watchlistQuery(profile.id), enabled: connected });
  const open = useOpenTitle();

  if (connections.isPending) return <GridSkeleton />;
  if (!connected) {
    return (
      <LibraryNotice
        icon={Unplug}
        title="Connect SIMKL or AniList"
        description="Your watchlist comes from the Plan to watch list on SIMKL and the Planning list on AniList. Connect one and what you planned shows up here."
        action={
          <Link to="/settings" search={{ section: "tracking" }} className={buttonVariants()}>
            Open Tracking settings
          </Link>
        }
      />
    );
  }
  if (list.isPending) return <GridSkeleton />;
  if (!list.data) {
    return (
      <LibraryNotice
        icon={Bookmark}
        title="Couldn’t load your watchlist"
        description="SIMKL or AniList didn’t answer. Check your connection and try again."
        action={<Button onClick={() => void list.refetch()}>Try again</Button>}
      />
    );
  }
  if (list.data.length === 0) {
    return (
      <LibraryNotice
        icon={Bookmark}
        title="Your watchlist is empty"
        description="Add a title to your watchlist from its page or its menu, or put it on Plan to watch in SIMKL or Planning in AniList."
      />
    );
  }
  return (
    <PosterGrid
      label="Watchlist"
      items={list.data}
      getKey={(item) => `${item.type}:${item.id}`}
      renderItem={(item) => (
        <PosterCard
          title={item.name}
          meta={item.year > 0 ? item.year : undefined}
          src={item.poster || undefined}
          menu={watchlistMenuTitle(item)}
          onClick={() => open(watchlistPreview(item))}
        />
      )}
    />
  );
}

const watchlistPreview = (item: WatchlistItem): TitlePreview => ({
  id: item.id,
  type: item.type,
  name: item.name,
  ...(item.poster ? { poster: item.poster } : {}),
  ...(item.year > 0 ? { releaseInfo: String(item.year) } : {}),
});

const watchlistMenuTitle = (item: WatchlistItem) =>
  menuTitle({ ...watchlistPreview(item), imdb_id: item.ids?.["imdb"] });
