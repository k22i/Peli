import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { FolderX } from "lucide-react";
import { useCallback } from "react";

import { NoAddons } from "@/components/addons/no-addons";
import { GridSkeleton, Notice } from "@/components/browse/browse-page";
import { Artwork } from "@/components/media/artwork";
import { PosterCard } from "@/components/media/cards";
import { HeroSkeleton, Logo } from "@/components/media/hero";
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
// folder's cover and title or logo, then its catalogs merged into one grid
// that loads more as it scrolls.
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
    <div className="flex flex-col gap-6 py-6">
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

// The cover in the tile's own shape, as on Home.
const coverShape: Record<string, string> = {
  POSTER: "aspect-[2/3] w-28",
  SQUARE: "aspect-square w-36",
};

// Like the Hero, but shorter, and always over the backdrop's dark scrim, so
// a title logo (drawn for dark art) reads in either theme. With no backdrop,
// the folder's generated gradient.
function FolderHeader({
  collection,
  folder,
}: {
  collection: Collection;
  folder: CollectionFolder;
}) {
  const title = folderTitle(folder);
  return (
    <section
      aria-label={folder.title}
      className={cn("relative px-gutter pt-4 dark:px-0 dark:pt-0", headerOffset)}
    >
      <div className="overflow-hidden rounded-2xl shadow-lift dark:rounded-none dark:shadow-none">
        <div className="dark relative isolate flex min-h-72 items-end gap-6 px-gutter pt-20 pb-10 text-foreground">
          <Artwork
            src={folder.backdrop || collection.backdrop}
            title={folder.title}
            className="absolute inset-0 -z-10"
          />
          <div className="absolute inset-0 -z-10 bg-linear-to-t from-black/85 via-black/40 to-black/10" />
          {folder.cover && (
            <div
              className={cn(
                "shrink-0 overflow-hidden rounded-xl shadow-lift",
                coverShape[folder.shape ?? ""] ?? "aspect-video w-56",
              )}
            >
              <Artwork src={folder.cover} title={folder.title} />
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-3">
            <p className="font-mono text-meta font-medium tracking-widest text-brand uppercase">
              {collection.title}
            </p>
            <h1 className="font-heading text-display text-balance font-stretch-expanded">
              {folder.logo ? <Logo src={folder.logo} title={title} className="max-h-24" /> : title}
            </h1>
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-12 bg-linear-to-t from-background to-transparent dark:block" />
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
    <div className="flex flex-col gap-6 py-6">
      <HeroSkeleton className={headerOffset} />
      <GridSkeleton />
    </div>
  );
}
