import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Info, Play, RotateCcw } from "lucide-react";

import { NoAddons } from "@/components/addons/no-addons";
import { LandscapeCard, PosterCard } from "@/components/media/cards";
import { Hero, HeroSkeleton } from "@/components/media/hero";
import { Row, RowGroup, RowSkeleton, rowLinkClassName } from "@/components/media/row";
import { Button } from "@/components/ui/button";
import {
  addonsFor,
  catalogQuery,
  metaQuery,
  type LoadedAddon,
  type MetaPreview,
} from "@/lib/addon-protocol";
import { useLeaveOutAnime } from "@/lib/anime";
import { browseTarget, isAnimeCatalog } from "@/lib/browse";
import { folderParams, folderPath } from "@/lib/folder";
import {
  collectionsQuery,
  homeLayoutQuery,
  homeRowLimit,
  homeRows,
  isReleased,
  useBrowsableAddons,
  type HomeRowOf,
} from "@/lib/home";
import {
  continueWatchingQuery,
  episodeLabel,
  libraryPreview,
  libraryQuery,
  timeLeft,
  watchedFraction,
} from "@/lib/library";
import { usePlay, type PlayTarget } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import { useOpenTitle, type TitlePreview } from "@/lib/title";
import { cn } from "@/lib/utils";
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
  const open = useOpenTitle();
  const library = useQuery(libraryQuery(profileId));
  const watching = useQuery(continueWatchingQuery(profileId));
  const layout = useQuery(homeLayoutQuery(profileId));
  const collections = useQuery(collectionsQuery(profileId));
  const { visible, addons, shown, loading: addonsLoading } = useBrowsableAddons(profileId);
  const leaveOutAnime = useLeaveOutAnime(profileId);
  // A catalog row waits for its manifest and for what a kids profile may
  // see (`shown`); until then the collections show alone.
  const rows = homeRows(layout.data, collections.data ?? [], addons, shown);

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
    <div className="flex flex-col pb-12">
      {featured ? (
        <CatalogHero
          row={featured}
          hideUnreleased={hideUnreleased}
          leaveOutAnime={leaveOutAnime}
          {...context}
        />
      ) : addonsLoading ? (
        <HeroSkeleton size="feature" />
      ) : (
        watching.data[0] && <WatchingHero entry={watching.data[0]} {...context} />
      )}
      {/* RowGroup renders no element, so its rows are this wrapper's children:
          a shelf apart (3rem), and 1.5rem below the hero. */}
      <div className="flex flex-col gap-12 pt-6">
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
              <CatalogRowView
                key={row.key}
                row={row}
                hideUnreleased={hideUnreleased}
                leaveOutAnime={leaveOutAnime}
              />
            ) : (
              <CollectionRow key={row.key} row={row} />
            ),
          )}
          {addonsLoading && <RowSkeleton />}
          {library.data.length > 0 && (
            <Row
              title="Your library"
              action={
                <Link to="/library" className={rowLinkClassName}>
                  See all
                  <ChevronRight aria-hidden />
                </Link>
              }
              items={library.data.slice(0, homeRowLimit)}
              getKey={(item) => `${item.contentId}:${item.contentType}`}
              renderItem={(item) => (
                <PosterCard
                  title={item.name}
                  meta={item.releaseInfo}
                  src={item.poster}
                  onClick={() => open(libraryPreview(item))}
                />
              )}
            />
          )}
        </RowGroup>
      </div>
    </div>
  );
}

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
      pill={episodeLabel(entry)}
      meta={timeLeft(entry)}
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
  leaveOutAnime,
  ...context
}: { row: CatalogRow; hideUnreleased: boolean; leaveOutAnime: LeaveOut } & WatchingContext) {
  const play = usePlay();
  const { addon, catalog } = row.source;
  const catalogData = useQuery(catalogQuery(addon.url, catalog.type, catalog.id));
  if (catalogData.isPending) return <HeroSkeleton size="feature" />;

  const leaveOut = leaveOutOf(row, leaveOutAnime);
  const meta = catalogData.data?.metas.find(
    (item) => item.background && (!hideUnreleased || isReleased(item)) && !leaveOut(item.id),
  );
  if (!meta) {
    return context.watching[0] ? <WatchingHero entry={context.watching[0]} {...context} /> : null;
  }
  const entry = context.watching.find((item) => item.contentId === meta.id);
  return (
    <Hero
      size="feature"
      title={meta.name}
      eyebrow={row.title}
      meta={metaLine(meta)}
      synopsis={meta.description}
      backdrop={meta.background}
      actions={
        <>
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
          <DetailsButton title={meta} />
        </>
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
      size="feature"
      title={title}
      eyebrow="Continue watching"
      meta={episode ? [episode] : []}
      synopsis={synopsis}
      backdrop={art}
      actions={
        <>
          <PlayButton resume onClick={() => play(resumeTarget(entry, title))} />
          <DetailsButton
            title={{ id: entry.contentId, type: entry.contentType, name: title, background: art }}
          />
        </>
      }
    />
  );
}

// Apple TV's pattern for hero actions: Play is solid white, the rest glass
// (media glass, since the hero is dark over any art). Pills that press in.
const heroButton =
  "rounded-full px-6 transition-transform duration-(--duration-fast) motion-safe:active:scale-[0.97]";

// The hero's title page.
function DetailsButton({ title }: { title: TitlePreview }) {
  const open = useOpenTitle();
  return (
    <Button
      size="lg"
      variant="ghost"
      className={cn(
        heroButton,
        "glass-media-strong text-white hover:text-white hover:before:bg-white/15",
      )}
      onClick={() => open(title)}
    >
      <Info />
      Details
    </Button>
  );
}

function PlayButton({ resume, onClick }: { resume: boolean; onClick: () => void }) {
  return (
    <Button
      size="lg"
      className={cn(
        heroButton,
        "border-transparent bg-white text-black hover:bg-white/90 data-pressed:bg-white/90",
      )}
      onClick={onClick}
    >
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
// empty isn't shown. A card opens its title page (#45).
type LeaveOut = (id: string) => boolean;

// Anime in a general catalog's row is the Anime tab's (#109); an anime
// catalog keeps all of it.
const leaveOutOf = (row: CatalogRow, leaveOutAnime: LeaveOut): LeaveOut =>
  isAnimeCatalog(row.source) ? () => false : leaveOutAnime;

function CatalogRowView({
  row,
  hideUnreleased,
  leaveOutAnime,
}: {
  row: CatalogRow;
  hideUnreleased: boolean;
  leaveOutAnime: LeaveOut;
}) {
  const open = useOpenTitle();
  const { addon, catalog } = row.source;
  const catalogData = useQuery(catalogQuery(addon.url, catalog.type, catalog.id));
  if (catalogData.isPending) return <RowSkeleton />;
  const leaveOut = leaveOutOf(row, leaveOutAnime);
  const metas = (catalogData.data?.metas ?? []).filter(
    (meta) => (!hideUnreleased || isReleased(meta)) && !leaveOut(meta.id),
  );
  if (metas.length === 0) return null;
  // Ten titles and a link to the rest, where a browse page has the catalog.
  const target = browseTarget(row.source);
  return (
    <Row
      title={row.title}
      action={
        target && (
          <Link to={target.to} search={{ catalog: target.catalog }} className={rowLinkClassName}>
            Browse all
            <ChevronRight aria-hidden />
          </Link>
        )
      }
      items={target ? metas.slice(0, homeRowLimit) : metas}
      getKey={(meta) => meta.id}
      card={(meta) => (meta.posterShape === "landscape" ? "landscape" : "poster")}
      renderItem={(meta) => {
        const Card = meta.posterShape === "landscape" ? LandscapeCard : PosterCard;
        return (
          <Card
            title={meta.name}
            meta={meta.releaseInfo}
            src={meta.poster}
            onClick={() => open(meta)}
          />
        );
      }}
    />
  );
}

// A collection's folders, as tiles. One opens as a merged grid (#96).
function CollectionRow({ row }: { row: Extract<HomeRow, { kind: "collection" }> }) {
  const navigate = useNavigate();
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
            onClick={() =>
              void navigate({ to: folderPath, params: folderParams(collection, folder) })
            }
          />
        );
      }}
    />
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col pb-12">
      <HeroSkeleton size="feature" />
      <div className="flex flex-col gap-12 pt-6">
        <RowSkeleton card="landscape" />
        <RowSkeleton />
      </div>
    </div>
  );
}
