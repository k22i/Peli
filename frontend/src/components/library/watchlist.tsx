import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bookmark, Unplug } from "lucide-react";

import { LibraryGridSkeleton, LibraryNotice } from "@/components/library/notice";
import { PosterCard } from "@/components/media/cards";
import { PosterGrid } from "@/components/media/poster-grid";
import { Button, buttonVariants } from "@/components/ui/button";
import { useCompactShell } from "@/lib/shell-mode";
import { connectedServices, trackingQuery, watchlistQuery } from "@/lib/tracking";
import { useOpenTitle, type TitlePreview } from "@/lib/title";
import { menuTitle } from "@/lib/title-actions";
import type { Profile } from "@bindings/store";
import type { WatchlistItem } from "@bindings/tracking";

// What the profile's connected lists have planned (SIMKL's Plan to watch,
// AniList's Planning), as the library's cards with the shared title menu, so
// Remove from Watchlist is a right-click away. The lists are theirs, not
// Peli's: nothing here is kept on this device or sent to Nuvio.
export function Watchlist({ profile }: { profile: Profile }) {
  const connections = useQuery(trackingQuery(profile.id));
  const connected = connectedServices(connections.data).length > 0;
  const list = useQuery({ ...watchlistQuery(profile.id), enabled: connected });
  const open = useOpenTitle();
  // The iPhone (#132): the dense grid, each card marked with the list it
  // comes from, and a one-sentence notice.
  const dense = useCompactShell();

  if (connections.isPending) return <LibraryGridSkeleton />;
  if (!connected && dense) {
    return (
      <LibraryNotice
        icon={Unplug}
        title="Your watchlist"
        description="Connect SIMKL or AniList in Settings."
        action={
          <Link to="/settings" search={{ section: "tracking" }} className={buttonVariants()}>
            Open Tracking settings
          </Link>
        }
      />
    );
  }
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
  if (list.isPending) return <LibraryGridSkeleton />;
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
      dense={dense}
      items={list.data}
      getKey={(item) => `${item.type}:${item.id}`}
      renderItem={(item) => (
        <PosterCard
          title={item.name}
          meta={item.year > 0 ? item.year : undefined}
          src={item.poster || undefined}
          dense={dense}
          corner={dense ? <SourceGlyphs services={item.services ?? []} /> : undefined}
          menu={watchlistMenuTitle(item)}
          onClick={() => open(watchlistPreview(item))}
        />
      )}
    />
  );
}

// Where a watchlist title comes from, as small marks over the poster's
// corner: SIMKL's "S" and AniList's "A" in their brand colours. The card's
// name says nothing about it, so the marks carry their own label.
const glyphs: Record<string, { letter: string; label: string; className: string }> = {
  simkl: { letter: "S", label: "On SIMKL", className: "bg-black text-white" },
  anilist: { letter: "A", label: "On AniList", className: "bg-[#02a9ff] text-white" },
};

function SourceGlyphs({ services }: { services: readonly string[] }) {
  const shown = services.filter((service) => glyphs[service]);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((service) => {
        const glyph = glyphs[service]!;
        return (
          <span
            key={service}
            className={`grid size-4.5 place-items-center rounded-[5px] text-[0.625rem] leading-none font-bold shadow-card ring-1 ring-white/20 ${glyph.className}`}
          >
            <span aria-hidden>{glyph.letter}</span>
            <span className="sr-only">{glyph.label}</span>
          </span>
        );
      })}
    </>
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
