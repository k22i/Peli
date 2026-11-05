import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { FolderX } from "lucide-react";
import { useCallback } from "react";

import { NoAddons } from "@/components/addons/no-addons";
import { GridSkeleton, Notice } from "@/components/browse/browse-page";
import { Artwork } from "@/components/media/artwork";
import { PosterCard } from "@/components/media/cards";
import { Ambient } from "@/components/media/ambient";
import { Hero, HeroSkeleton, Logo } from "@/components/media/hero";
import { PosterGrid } from "@/components/media/poster-grid";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  findFolder,
  folderSources,
  mergeSources,
  useFolderPages,
  type FolderSource,
} from "@/lib/folder";
import { collectionsQuery, homeLayoutQuery, isReleased, useBrowsableAddons } from "@/lib/home";
import { currentProfileQuery } from "@/lib/profile";
import { useOpenTitle } from "@/lib/title";
import { cn } from "@/lib/utils";
import type { Collection, CollectionFolder, Profile } from "@bindings/store";

// A collection folder (#96), opened from its tile on Home: a header with the
// folder's cover and title or logo (a banner, or the cover beside the title,
// #119), then its catalogs merged into one grid that loads more as it scrolls.
export function FolderPage() {
  const { collectionId, folderId } = useParams({ from: "/folder/$collectionId/$folderId" });
  const profile = useQuery(currentProfileQuery).data;
  return profile ? (
    <Folder profile={profile} collectionId={collectionId} folderId={folderId} />
  ) : (
    <FolderSkeleton />
  );
}

function Folder({
  profile,
  collectionId,
  folderId,
}: {
  profile: Profile;
  collectionId: string;
  folderId: string;
}) {
  const collections = useQuery(collectionsQuery(profile.id));
  const { visible, addons, shown, loading } = useBrowsableAddons(profile.id);
  const hideUnreleased = useQuery(homeLayoutQuery(profile.id)).data?.hideUnreleased ?? false;

  if (collections.isPending) return <FolderSkeleton />;
  const found = findFolder(collections.data ?? [], collectionId, folderId);
  if (!found) {
    // Removed in Nuvio's apps since Home showed it, or a kids profile, which
    // gets no collections (ADR-0022).
    return (
      <div className="py-6">
        <Notice
          icon={FolderX}
          title="This folder isn’t here any more"
          description="It may have been removed in Nuvio’s apps."
          action={
            <Link to="/" className={buttonVariants({ variant: "outline" })}>
              Back to Home
            </Link>
          }
        />
      </div>
    );
  }

  const { collection, folder } = found;
  const sources = loading ? [] : folderSources(folder, addons, shown);
  return (
    <div className="flex flex-col gap-8 py-6">
      <FolderHeader collection={collection} folder={folder} />
      {visible.data?.length === 0 ? (
        <NoAddons profile={profile} />
      ) : loading ? (
        <GridSkeleton />
      ) : sources.length === 0 ? (
        <Notice
          title="Nothing to show"
          description="None of this folder’s catalogs comes from an addon you have. Install or turn on the addons it uses."
          action={
            <Link to="/addons" className={buttonVariants({ variant: "outline" })}>
              Manage addons
            </Link>
          }
        />
      ) : (
        <FolderGrid
          key={sources.map((source) => source.key).join("\n")}
          sources={sources}
          label={folder.title}
          hideUnreleased={hideUnreleased}
        />
      )}
    </div>
  );
}

const folderTitle = (folder: CollectionFolder) =>
  folder.emoji ? `${folder.emoji} ${folder.title}` : folder.title;

// The collection's name above the title: Mona Sans, small, uppercase and
// tracked (not the hero's mono).
const eyebrow = (collection: Collection) => (
  <span className="font-sans font-semibold tracking-[0.06em]">{collection.title}</span>
);

// The header takes the cover's shape (#119). A poster or square cover stands
// beside the title block, over a haze of its own colours; anything else is a
// short banner (the Hero), with the cover as its art, or, with no cover, the
// folder's backdrop or its generated gradient.
function FolderHeader({
  collection,
  folder,
}: {
  collection: Collection;
  folder: CollectionFolder;
}) {
  const title = folderTitle(folder);
  if (folder.cover && (folder.shape === "POSTER" || folder.shape === "SQUARE")) {
    return <CoverHeader collection={collection} folder={folder} cover={folder.cover} />;
  }
  return (
    <Hero
      compact
      title={title}
      logo={folder.logo}
      eyebrow={eyebrow(collection)}
      backdrop={folder.cover || folder.backdrop || collection.backdrop}
      fallbackBackdrop={folder.backdrop || collection.backdrop}
      className={headerOffset}
    />
  );
}

// The cover at w-56 beside the title, over the cover's own colours.
function CoverHeader({
  collection,
  folder,
  cover,
}: {
  collection: Collection;
  folder: CollectionFolder;
  cover: string;
}) {
  const title = folderTitle(folder);
  const poster = folder.shape === "POSTER";
  return (
    <section
      aria-label={folder.title}
      className="relative isolate flex items-end gap-8 px-gutter pt-6"
    >
      {/* Runs under the title bar and the sidebar, to the window's edge. */}
      <Ambient
        src={cover}
        className="top-[calc(-1*(var(--titlebar-h)+1.5rem))] -ms-(--sidebar-inset)"
      />
      <div
        className={cn(
          "w-56 shrink-0 overflow-hidden rounded-2xl shadow-lift",
          poster ? "aspect-[2/3]" : "aspect-square",
        )}
      >
        <Artwork src={cover} use={poster ? "poster" : "landscape"} title={folder.title} />
      </div>
      <div className="flex min-w-0 flex-col gap-3 pb-2">
        <p className="text-meta font-semibold tracking-[0.06em] text-brand uppercase">
          {collection.title}
        </p>
        <h1 className="font-heading text-display text-balance font-stretch-expanded">
          {folder.logo ? <Logo src={folder.logo} title={title} className="max-h-24" /> : title}
        </h1>
      </div>
    </section>
  );
}

// Flush with the top of the page, as Home's hero is.
const headerOffset = "-mt-6";

function FolderGrid({
  sources,
  label,
  hideUnreleased,
}: {
  sources: readonly FolderSource[];
  label: string;
  hideUnreleased: boolean;
}) {
  const open = useOpenTitle();
  const results = useFolderPages(sources);
  const items = results.map((result) => ({
    metas: result.data?.pages.flatMap((page) => page.metas) ?? [],
    // A source that failed outright has nothing more to give; one whose next
    // page failed waits for Try again.
    more: result.isPending || result.hasNextPage,
  }));
  const { metas: merged, behind } = mergeSources(items);
  const metas = hideUnreleased ? merged.filter((meta) => isReleased(meta)) : merged;

  // A new callback whenever the sources holding the grid back move, so the
  // grid asks again even when their new page only had titles it already
  // shows.
  const wanted = behind.map((i) => `${i}:${items[i]!.metas.length}`).join();
  const loadMore = useCallback(() => {
    for (const i of behind) {
      const result = results[i]!;
      if (result.hasNextPage && !result.isFetching) void result.fetchNextPage();
    }
    // oxlint-disable-next-line react/exhaustive-deps -- `wanted` names `behind`.
  }, [wanted, results]);

  const failed = results.filter((result) => result.isError && !result.data);
  const nextFailed = results.filter((result) => result.isFetchNextPageError);
  if (metas.length === 0 && results.some((result) => result.isPending)) return <GridSkeleton />;
  if (failed.length === results.length) {
    return (
      <Notice
        title={`Couldn’t load ${label}`}
        description="Its addons didn’t answer. They may be down, or you may be offline."
        action={
          <Button onClick={() => failed.forEach((result) => void result.refetch())}>
            Try again
          </Button>
        }
      />
    );
  }
  if (metas.length === 0 && behind.length === 0) {
    return <Notice title="Nothing here" description={`${label} is empty.`} />;
  }

  return (
    <>
      <PosterGrid
        label={label}
        items={metas}
        getKey={(meta) => meta.id}
        renderItem={(meta) => (
          <PosterCard
            title={meta.name}
            meta={meta.releaseInfo}
            src={meta.poster}
            onClick={() => open(meta)}
          />
        )}
        onEndReached={loadMore}
      />
      <div className="flex min-h-10 justify-center px-gutter">
        {results.some((result) => result.isFetchingNextPage) ? (
          <Spinner aria-label="Loading more" />
        ) : (
          nextFailed.length > 0 && (
            <Button
              variant="outline"
              onClick={() => nextFailed.forEach((result) => void result.fetchNextPage())}
            >
              Couldn’t load more. Try again
            </Button>
          )
        )}
      </div>
    </>
  );
}

function FolderSkeleton() {
  return (
    <div className="flex flex-col gap-8 py-6">
      <HeroSkeleton compact className={headerOffset} />
      <GridSkeleton />
    </div>
  );
}
