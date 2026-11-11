import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Info, Play, RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { NoAddons } from "@/components/addons/no-addons";
import { NewEpisodes, SurpriseButton } from "@/components/home/home-extras";
import { AnimePosterCard } from "@/components/media/anime-poster-card";
import { LandscapeCard, PosterCard } from "@/components/media/cards";
import { Hero, HeroSkeleton, ImdbScore } from "@/components/media/hero";
import { prefersReducedMotion } from "@/components/media/roving";
import { Row, RowGroup, RowSkeleton, rowLinkClassName } from "@/components/media/row";
import { Button } from "@/components/ui/button";
import {
  addonsFor,
  catalogQuery,
  metaQuery,
  type LoadedAddon,
  type MetaPreview,
} from "@/lib/addon-protocol";
import { libraryMenuTitle, menuTitle } from "@/lib/title-actions";
import { useLeaveOutAnime } from "@/lib/anime";
import { useAnimePosterAddon } from "@/lib/anime-posters";
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
  const posterAddon = useAnimePosterAddon(profileId);
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
        <p className="p-8 text-center text-body text-muted-foreground">
          Titles you save and watch show up here.
        </p>
      )
    );
  }

  const featured = rows.find((row): row is CatalogRow => row.kind === "catalog");
  const hideUnreleased = layout.data?.hideUnreleased ?? false;
  const context = { addons, library: library.data, watching: watching.data };
  const surprise = <SurpriseButton profileId={profileId} source={featured?.source} />;
  return (
    <div className="flex flex-col pb-12">
      {featured ? (
        <CatalogHero
          row={featured}
          hideUnreleased={hideUnreleased}
          leaveOutAnime={leaveOutAnime}
          surprise={surprise}
          {...context}
        />
      ) : addonsLoading ? (
        <HeroSkeleton size="feature" />
      ) : (
        watching.data[0] && (
          <WatchingHero entry={watching.data[0]} surprise={surprise} {...context} />
        )
      )}
      {/* RowGroup renders no element, so its rows are this wrapper's children:
          a shelf apart, and tucked up under the hero's fade. */}
      <div className="relative flex flex-col gap-9 pt-1">
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
          <NewEpisodes profile={profile} />
          {rows.map((row) =>
            row.kind === "catalog" ? (
              <CatalogRowView
                key={row.key}
                row={row}
                hideUnreleased={hideUnreleased}
                leaveOutAnime={leaveOutAnime}
                posterAddon={posterAddon}
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
                  menu={libraryMenuTitle(item)}
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
      menu={{ id: entry.contentId, type: entry.contentType, name: title, poster: art }}
      progress={watchedFraction(entry)}
      onClick={() => play(resumeTarget(entry, title))}
    />
  );
}

// The marquee: the first few titles with a backdrop in the first catalog
// row, which is the user's own pick of what comes first. It turns slowly
// (every 9 s) while the window is left alone, holds still under the pointer
// or focus, and never moves with reduced motion. Resume picks up where
// Continue Watching left it.
const marqueeSize = 5;
const marqueeMs = 9000;

function CatalogHero({
  row,
  hideUnreleased,
  leaveOutAnime,
  surprise,
  ...context
}: {
  row: CatalogRow;
  hideUnreleased: boolean;
  leaveOutAnime: LeaveOut;
  surprise: ReactNode;
} & WatchingContext) {
  const play = usePlay();
  const { addon, catalog } = row.source;
  const catalogData = useQuery(catalogQuery(addon.url, catalog.type, catalog.id));
  const leaveOut = leaveOutOf(row, leaveOutAnime);
  const metas = (catalogData.data?.metas ?? [])
    .filter(
      (item) => item.background && (!hideUnreleased || isReleased(item)) && !leaveOut(item.id),
    )
    .slice(0, marqueeSize);
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const count = metas.length;

  useEffect(() => {
    if (held || count < 2 || prefersReducedMotion()) return undefined;
    // From the title on show now, so picking a dot restarts its turn.
    const next = (index + 1) % count;
    const timer = setTimeout(() => setIndex(next), marqueeMs);
    return () => clearTimeout(timer);
  }, [held, count, index]);

  if (catalogData.isPending) return <HeroSkeleton size="feature" />;
  const meta = metas[index % Math.max(count, 1)];
  if (!meta) {
    return context.watching[0] ? (
      <WatchingHero entry={context.watching[0]} surprise={surprise} {...context} />
    ) : null;
  }
  const entry = context.watching.find((item) => item.contentId === meta.id);
  return (
    <div
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <Hero
        key={meta.id}
        size="feature"
        title={meta.name}
        logo={meta.logo}
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
            {surprise}
          </>
        }
        aside={
          count > 1 && (
            <MarqueeDots count={count} index={index} onPick={setIndex} titles={metas} held={held} />
          )
        }
      />
    </div>
  );
}

// One dash per title; the current one is long and fills with sunlight as
// its turn runs out.
function MarqueeDots({
  count,
  index,
  onPick,
  titles,
  held,
}: {
  held: boolean;
  count: number;
  index: number;
  onPick: (index: number) => void;
  titles: readonly MetaPreview[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: count }, (_, dot) => (
        <button
          key={titles[dot]?.id ?? dot}
          type="button"
          aria-label={`Show ${titles[dot]?.name ?? dot + 1}`}
          aria-current={dot === index || undefined}
          onClick={() => onPick(dot)}
          className={cn(
            "relative h-1.5 overflow-hidden rounded-full bg-white/30 outline-none transition-[width,background-color] duration-(--duration-slow) ease-out-soft hover:bg-white/55 focus-visible:ring-2 focus-visible:ring-ring",
            dot === index ? "w-8" : "w-1.5",
          )}
        >
          {dot === index && (
            <span
              key={held ? "held" : "running"}
              className={cn(
                "absolute inset-0 origin-left rounded-full bg-white",
                !held && "motion-safe:animate-[marquee-fill_9s_linear_both]",
              )}
            />
          )}
        </button>
      ))}
    </div>
  );
}

// With no catalog to feature, the title last watched.
function WatchingHero({
  entry,
  surprise,
  ...context
}: { entry: Progress; surprise: ReactNode } & WatchingContext) {
  const play = usePlay();
  const { title, art, synopsis } = useWatchingDetails(entry, context);
  if (!art) return null;
  const episode = episodeLabel(entry);
  return (
    <Hero
      size="feature"
      title={title}
      eyebrow="Continue watching"
      meta={episode ? [<span key="episode">{episode}</span>] : []}
      synopsis={synopsis}
      backdrop={art}
      actions={
        <>
          <PlayButton resume onClick={() => play(resumeTarget(entry, title))} />
          <DetailsButton
            title={{ id: entry.contentId, type: entry.contentType, name: title, background: art }}
          />
          {surprise}
        </>
      }
    />
  );
}

// The hero's title page.
function DetailsButton({ title }: { title: TitlePreview }) {
  const open = useOpenTitle();
  return (
    <Button size="xl" variant="media" onClick={() => open(title)}>
      <Info />
      Details
    </Button>
  );
}

function PlayButton({ resume, onClick }: { resume: boolean; onClick: () => void }) {
  return (
    <Button size="xl" variant="light" className="min-w-36" onClick={onClick}>
      {resume ? <RotateCcw /> : <Play className="fill-current" />}
      {resume ? "Resume" : "Play"}
    </Button>
  );
}

// "2024 · ★ 7.5 · Drama · Comedy".
function metaLine(meta: MetaPreview): ReactNode[] {
  return [
    meta.releaseInfo && <span key="year">{meta.releaseInfo}</span>,
    meta.imdbRating && <ImdbScore key="imdb" rating={meta.imdbRating} />,
    ...(meta.genres ?? []).slice(0, 2).map((genre) => <span key={genre}>{genre}</span>),
  ].filter(Boolean);
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
  posterAddon,
}: {
  row: CatalogRow;
  hideUnreleased: boolean;
  leaveOutAnime: LeaveOut;
  // The profile's poster addon, for an anime catalog's posters.
  posterAddon: LoadedAddon | undefined;
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
  const anime = posterAddon !== undefined && isAnimeCatalog(row.source);
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
        if (anime && meta.posterShape !== "landscape") {
          return (
            <AnimePosterCard
              id={meta.id}
              posterAddon={posterAddon}
              title={meta.name}
              meta={meta.releaseInfo}
              src={meta.poster}
              menu={menuTitle(meta)}
              onClick={() => open(meta)}
            />
          );
        }
        const Card = meta.posterShape === "landscape" ? LandscapeCard : PosterCard;
        return (
          <Card
            title={meta.name}
            meta={meta.releaseInfo}
            src={meta.poster}
            menu={menuTitle(meta)}
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
      <div className="flex flex-col gap-9 pt-1">
        <RowSkeleton card="landscape" />
        <RowSkeleton />
      </div>
    </div>
  );
}
