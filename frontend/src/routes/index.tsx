import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Play, RotateCcw } from "lucide-react";

import { NoAddons } from "@/components/addons/no-addons";
import { LandscapeCard, PosterCard } from "@/components/media/cards";
import { Hero, HeroSkeleton } from "@/components/media/hero";
import { Row, RowGroup, RowSkeleton } from "@/components/media/row";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  addonsFor,
  catalogQuery,
  manifestQuery,
  metaQuery,
  type LoadedAddon,
  type MetaPreview,
} from "@/lib/addon-protocol";
import { visibleAddonsQuery } from "@/lib/addons";
import {
  catalogRef,
  collectionsQuery,
  hiddenCatalogsQuery,
  homeLayoutQuery,
  homeRows,
  isReleased,
  type HomeRowOf,
} from "@/lib/home";
import { continueWatchingQuery, episodeLabel, libraryQuery, watchedFraction } from "@/lib/library";
import { usePlay, type PlayTarget } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import type { LibraryItem, Profile, Progress } from "@bindings/store";

export const Route = createFileRoute("/")({
  component: Home,
});

type HomeRow = HomeRowOf<LoadedAddon>;
type CatalogRow = Extract<HomeRow, { kind: "catalog" }>;

// Home (#42): a hero, Continue Watching, then the collections and catalog
// rows in the order of the layout made in Nuvio's apps (#35), and the
// library. Continue Watching, the collections and the library come from the
// local store, so they show offline (#31); manifests and catalogs come from
// the persisted cache first, so a warm launch paints them without waiting
// on the network, and fresh pages fill in behind. With no addon to browse,
// it says how to add one first (#39), so a fresh install never opens on an
// empty page.
function Home() {
  const profile = useQuery(currentProfileQuery).data;
  return (
    <>
      <h1 className="sr-only">Home</h1>
      {profile ? <HomeRows profile={profile} /> : <HomeSkeleton />}
    </>
  );
}

function HomeRows({ profile }: { profile: Profile }) {
  const profileId = profile.id;
  const visible = useQuery(visibleAddonsQuery(profileId));
  const library = useQuery(libraryQuery(profileId));
  const watching = useQuery(continueWatchingQuery(profileId));
  const layout = useQuery(homeLayoutQuery(profileId));
  const collections = useQuery(collectionsQuery(profileId));

  // The visible addons whose manifests loaded, in the user's order. One that
  // fails to load drops out of the rows and stays installed.
  const manifests = useQueries({
    queries: (visible.data ?? []).map((addon) => manifestQuery(addon.url)),
  });
  const addons: LoadedAddon[] = (visible.data ?? []).flatMap((addon, index) => {
    const manifest = manifests[index]?.data;
    return manifest ? [{ url: addon.url, manifest }] : [];
  });
  const hidden = useQuery(
    hiddenCatalogsQuery(
      profileId,
      addons.flatMap((addon) => addon.manifest.catalogs.map((catalog) => ({ addon, catalog }))),
    ),
  );
  // Catalog rows wait for the manifests and for what a kids profile may
  // see; until then the collections show alone.
  const addonsLoading =
    visible.isPending || manifests.some((query) => query.isPending) || hidden.isPending;
  const rows = homeRows(
    layout.data,
    collections.data ?? [],
    hidden.data ? addons : [],
    (source) => !hidden.data?.has(catalogRef(source)),
  );

  const noAddons = visible.data?.length === 0 && <NoAddons profile={profile} />;
  if (!library.data || !watching.data) {
    return library.isError || watching.isError ? noAddons || null : <HomeSkeleton />;
  }
  if (
    library.data.length === 0 &&
    watching.data.length === 0 &&
    rows.length === 0 &&
    !addonsLoading
  ) {
    return (
      noAddons || (
        <p className="p-8 text-center text-sm text-muted-foreground">
          Titles you save and watch show up here.
        </p>
      )
    );
  }

  const featured = rows.find((row): row is CatalogRow => row.kind === "catalog");
  const hideUnreleased = layout.data?.hideUnreleased ?? false;
  const context = { addons, library: library.data, watching: watching.data };
  return (
    <div className="flex flex-col gap-6 py-6">
      {featured ? (
        <CatalogHero row={featured} hideUnreleased={hideUnreleased} {...context} />
      ) : addonsLoading ? (
        <HeroSkeleton className={heroOffset} />
      ) : (
        watching.data[0] && <WatchingHero entry={watching.data[0]} {...context} />
      )}
      {noAddons}
      <RowGroup>
        {watching.data.length > 0 && (
          <Row
            title="Continue watching"
            card="landscape"
            items={watching.data}
            getKey={(entry) => entry.key}
            renderItem={(entry) => <WatchingCard entry={entry} {...context} />}
          />
        )}
        {rows.map((row) =>
          row.kind === "catalog" ? (
            <CatalogRowView key={row.key} row={row} hideUnreleased={hideUnreleased} />
          ) : (
            <CollectionRow key={row.key} row={row} />
          ),
        )}
        {addonsLoading && <RowSkeleton />}
        {library.data.length > 0 && (
          <Row
            title="Your library"
            action={
              <Link to="/library" className={buttonVariants({ variant: "link", size: "sm" })}>
                See all
              </Link>
            }
            items={library.data}
            getKey={(item) => `${item.contentId}:${item.contentType}`}
            renderItem={(item) => (
              <PosterCard title={item.name} meta={item.releaseInfo} src={item.poster} />
            )}
          />
        )}
      </RowGroup>
    </div>
  );
}

// The hero sits at the top of the page, under its padding: flush in dark
// mode, where it runs edge to edge, and inset by its own in light.
const heroOffset = "-mt-6";

type WatchingContext = {
  addons: readonly LoadedAddon[];
  library: readonly LibraryItem[];
  watching: readonly Progress[];
};

// A Continue Watching entry's name and art: the library's copy if it's
// saved, otherwise the first addon that has its meta (kept across restarts,
// so it's there from cache next launch).
function useWatchingDetails(entry: Progress, { addons, library }: WatchingContext) {
  const saved = library.find((item) => item.contentId === entry.contentId);
  const [addon] = addonsFor(addons, "meta", entry.contentType, entry.contentId);
  const meta = useQuery({
    ...metaQuery(addon?.url ?? "", entry.contentType, entry.contentId),
    enabled: !saved && addon !== undefined,
  }).data?.meta;
  return {
    title: saved?.name || meta?.name || entry.contentId,
    art: saved?.background || meta?.background || saved?.poster || meta?.poster,
    synopsis: meta?.description,
  };
}

const resumeTarget = (entry: Progress, title: string): PlayTarget => ({
  type: entry.contentType,
  id: entry.contentId,
  title,
  videoId: entry.videoId,
  resumeAt: entry.position,
});

// Resumes where the entry was left: launch, this, then a stream (#40).
function WatchingCard({ entry, ...context }: { entry: Progress } & WatchingContext) {
  const play = usePlay();
  const { title, art } = useWatchingDetails(entry, context);
  return (
    <LandscapeCard
      title={title}
      meta={episodeLabel(entry)}
      src={art}
      progress={watchedFraction(entry)}
      onClick={() => play(resumeTarget(entry, title))}
    />
  );
}

// The first item with a backdrop in the first catalog row, which is the
// user's own pick of what comes first. It doesn't rotate, so Home holds
// still; Resume picks up where Continue Watching left it.
function CatalogHero({
  row,
  hideUnreleased,
  ...context
}: { row: CatalogRow; hideUnreleased: boolean } & WatchingContext) {
  const play = usePlay();
  const { addon, catalog } = row.source;
  const catalogData = useQuery(catalogQuery(addon.url, catalog.type, catalog.id));
  if (catalogData.isPending) return <HeroSkeleton className={heroOffset} />;

  const meta = catalogData.data?.metas.find(
    (item) => item.background && (!hideUnreleased || isReleased(item)),
  );
  if (!meta) {
    return context.watching[0] ? <WatchingHero entry={context.watching[0]} {...context} /> : null;
  }
  const entry = context.watching.find((item) => item.contentId === meta.id);
  return (
    <Hero
      className={heroOffset}
      title={meta.name}
      eyebrow={row.title}
      meta={metaLine(meta)}
      synopsis={meta.description}
      backdrop={meta.background}
      actions={
        <PlayButton
          resume={entry !== undefined}
          onClick={() =>
            play(
              entry
                ? resumeTarget(entry, meta.name)
                : { type: meta.type, id: meta.id, title: meta.name },
            )
          }
        />
      }
    />
  );
}

// With no catalog to feature, the title last watched.
function WatchingHero({ entry, ...context }: { entry: Progress } & WatchingContext) {
  const play = usePlay();
  const { title, art, synopsis } = useWatchingDetails(entry, context);
  if (!art) return null;
  const episode = episodeLabel(entry);
  return (
    <Hero
      className={heroOffset}
      title={title}
      eyebrow="Continue watching"
      meta={episode ? [episode] : []}
      synopsis={synopsis}
      backdrop={art}
      actions={<PlayButton resume onClick={() => play(resumeTarget(entry, title))} />}
    />
  );
}

function PlayButton({ resume, onClick }: { resume: boolean; onClick: () => void }) {
  return (
    <Button size="lg" onClick={onClick}>
      {resume ? <RotateCcw /> : <Play className="fill-current" />}
      {resume ? "Resume" : "Play"}
    </Button>
  );
}

// "2024 · IMDb 7.5 · Drama · Comedy"
function metaLine(meta: MetaPreview): string[] {
  return [
    meta.releaseInfo,
    meta.imdbRating && `IMDb ${meta.imdbRating}`,
    ...(meta.genres ?? []).slice(0, 2),
  ].filter((item): item is string => Boolean(item));
}

// A catalog's first page, from cache first. One that fails or comes back
// empty isn't shown. Opening a title is the title page's (#45).
function CatalogRowView({ row, hideUnreleased }: { row: CatalogRow; hideUnreleased: boolean }) {
  const { addon, catalog } = row.source;
  const catalogData = useQuery(catalogQuery(addon.url, catalog.type, catalog.id));
  if (catalogData.isPending) return <RowSkeleton />;
  const metas = (catalogData.data?.metas ?? []).filter(
    (meta) => !hideUnreleased || isReleased(meta),
  );
  if (metas.length === 0) return null;
  return (
    <Row
      title={row.title}
      items={metas}
      getKey={(meta) => meta.id}
      card={(meta) => (meta.posterShape === "landscape" ? "landscape" : "poster")}
      renderItem={(meta) => {
        const Card = meta.posterShape === "landscape" ? LandscapeCard : PosterCard;
        return <Card title={meta.name} meta={meta.releaseInfo} src={meta.poster} />;
      }}
    />
  );
}

// A collection's folders, as tiles. Opening one is the browse page's (#43).
function CollectionRow({ row }: { row: Extract<HomeRow, { kind: "collection" }> }) {
  const { collection } = row;
  const folders = collection.folders ?? [];
  if (folders.length === 0) return null;
  return (
    <Row
      title={collection.title}
      items={folders}
      getKey={(folder) => folder.id}
      card={(folder) => (folder.shape === "POSTER" ? "poster" : "landscape")}
      renderItem={(folder) => {
        const Card = folder.shape === "POSTER" ? PosterCard : LandscapeCard;
        return (
          <Card
            title={folder.emoji ? `${folder.emoji} ${folder.title}` : folder.title}
            src={folder.cover || folder.backdrop}
          />
        );
      }}
    />
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <HeroSkeleton className={heroOffset} />
      <RowSkeleton card="landscape" />
      <RowSkeleton />
    </div>
  );
}
