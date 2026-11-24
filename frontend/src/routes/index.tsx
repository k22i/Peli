import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Info, Play, RotateCcw } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { NoAddons } from "@/components/addons/no-addons";
import { heroArrowStep } from "@/lib/marquee";
import { DownloadedRow, finishedDownloads } from "@/components/home/downloaded-row";
import { NewEpisodes, SurpriseButton } from "@/components/home/home-extras";
import { refreshSynced, usePullToRefresh } from "@/components/shell/pull-to-refresh";
import { AnimeTitleCard } from "@/components/media/anime-title-card";
import { EagerArtwork, preloadArtwork, useArtworkDevice } from "@/components/media/artwork";
import { DeferredRow } from "@/components/media/deferred-row";
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
import {
  followAll,
  prefetchAnimePoster,
  useAnimePosterAddon,
  useFollowAnime,
} from "@/lib/anime-titles";
import { browseTarget, isAnimeCatalog } from "@/lib/browse";
import { useDownloads } from "@/lib/downloads";
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
import { useConnection } from "@/lib/sync";
import { useOpenTitle, type TitlePreview } from "@/lib/title";
import { cn } from "@/lib/utils";
import type { LibraryItem, Profile, Progress } from "@bindings/store";
import { Connection } from "@bindings/syncer";

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
  // Pull to refresh on iOS (#135): sync now, and the tracker lists.
  const client = useQueryClient();
  usePullToRefresh(() => refreshSynced(client));
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
  const device = useArtworkDevice();
  const library = useQuery(libraryQuery(profileId));
  const watching = useQuery(continueWatchingQuery(profileId));
  const layout = useQuery(homeLayoutQuery(profileId));
  const collections = useQuery(collectionsQuery(profileId));
  const { visible, addons, shown, loading: addonsLoading } = useBrowsableAddons(profileId);
  const leaveOutAnime = useLeaveOutAnime(profileId);
  const posterAddon = useAnimePosterAddon(profileId);
  // Downloads (#85, part 9): what this device holds, played from the file.
  // Offline they come first, so the titles that play are the ones in reach.
  const downloads = useDownloads(profileId);
  const finished = finishedDownloads(downloads);
  const offline = useConnection() === Connection.Offline;
  const downloadedFirst = offline && finished.length > 0;
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
    finished.length === 0 &&
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
        {downloadedFirst && <DownloadedRow downloads={finished} />}
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
          {!downloadedFirst && finished.length > 0 && <DownloadedRow downloads={finished} />}
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
            <DeferredRow
              preload={() => {
                for (const item of library.data?.slice(0, homeRowLimit) ?? []) {
                  preloadArtwork(item.poster, "poster", device);
                }
              }}
            >
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
            </DeferredRow>
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
const ease = () => (prefersReducedMotion() ? 0 : 460);

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
  // ← and → page the marquee while focus is in it. The buttons and dashes
  // are one set over the slides, not part of them, so focus never moves.
  const frame = useRef<HTMLDivElement>(null);
  // The title the buttons and dashes show: the one arriving, while a turn runs.
  const [arriving, setArriving] = useState<number>();
  const followDash = useRef(false);
  const [announced, setAnnounced] = useState("");
  // A carousel: the previous, current and next titles sit side by side on a
  // track, so the neighbours slide in under the pointer as you drag (mouse,
  // pen or touch) and the track settles on one with an ease-out. Past a fifth
  // of the width, or a quick flick, it turns; otherwise it springs back.
  // Vertical moves stay the page's own scroll (touch-action: pan-y).
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; at: number; on: boolean } | null>(null);
  const dragged = useRef(false);
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Where the track is dragged to, in px from rest: negative shows the next title.
  const offset = useRef(0);
  const wheel = useRef<{ locked: boolean; idle?: number }>({ locked: false });
  const place = (px: number, ms = 0) => {
    const element = track.current;
    if (!element) return;
    offset.current = px;
    element.style.transition = ms ? `transform ${ms}ms var(--ease-out-soft)` : "none";
    element.style.transform = `translateX(calc(-100% + ${px}px))`;
  };
  // One title on (by = 1) or back (-1), animated from wherever the track is;
  // the index changes once it has arrived.
  const go = (by: number) => {
    const element = track.current;
    if (!element || count < 2 || settling.current) return;
    const ms = ease();
    setArriving((index + by + count) % count);
    element.style.transition = ms ? `transform ${ms}ms var(--ease-out-soft)` : "none";
    element.style.transform = `translateX(${-100 - by * 100}%)`;
    settling.current = setTimeout(() => {
      settling.current = undefined;
      const to = (index + by + count) % count;
      // Swap the titles and put the track back in one go, before a paint.
      flushSync(() => {
        setIndex(to);
        setArriving(undefined);
      });
      place(0);
      if (followDash.current) {
        frame.current
          ?.querySelector<HTMLElement>("[data-marquee-dot][aria-current]")
          ?.focus({ preventScroll: true });
      }
      followDash.current = false;
      setAnnounced(`${to + 1} of ${count}: ${metas[to]?.name ?? ""}`);
    }, ms);
  };
  const goLater = useEffectEvent((by: number) => go(by));
  const page = useEffectEvent((event: KeyboardEvent) => {
    const by = heroArrowStep(event, count);
    if (!by) return;
    event.preventDefault();
    // From a dash, focus follows to the dash of the title that arrives.
    followDash.current = document.activeElement?.hasAttribute("data-marquee-dot") === true;
    go(by);
  });
  // A listener on the frame, as it's no control itself. Attached after each
  // render: the frame mounts only once there's a title.
  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    element.addEventListener("keydown", page);
    return () => element.removeEventListener("keydown", page);
  });

  useEffect(() => () => clearTimeout(settling.current), []);
  const pick = (dot: number) => {
    const by = (dot - index + count) % count;
    if (by === 1) go(1);
    else if (by === count - 1) go(-1);
    else setIndex(dot);
  };
  // Let go of a drag: turn when it went a fifth of the way or was flicked.
  const release = (dx: number, flick: boolean) => {
    const width = frame.current?.clientWidth ?? 1;
    if (Math.abs(dx) > width / 5 || (flick && Math.abs(dx) > 30)) go(dx < 0 ? 1 : -1);
    else place(0, ease());
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    if (!state.on) return;
    const dx = event.clientX - state.x;
    if (event.type === "pointercancel") place(0, ease());
    else release(dx, Math.abs(dx) / Math.max(performance.now() - state.at, 1) > 0.45);
  };
  // A sideways trackpad swipe drags the track like a finger does, a bit
  // slower than the pointer; it settles when the swipe (and its momentum) is
  // over, and that tail never starts a second turn.
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    const width = frame.current?.clientWidth ?? 0;
    if (count < 2 || !width) return;
    window.clearTimeout(wheel.current.idle);
    wheel.current.idle = window.setTimeout(() => {
      if (wheel.current.locked) wheel.current.locked = false;
      else if (!settling.current && offset.current) release(offset.current, false);
    }, 110);
    if (settling.current || wheel.current.locked) return;
    const next = Math.max(-width, Math.min(width, offset.current - event.deltaX * 0.8));
    place(next);
    // Carried past halfway by momentum: turn now rather than wait for it to die.
    if (Math.abs(next) > width / 2) {
      wheel.current.locked = true;
      go(next < 0 ? 1 : -1);
    }
  });
  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });
  // The neighbours' art is fetched ahead, so a drag shows them, not a blank.
  const device = useArtworkDevice();
  const backdrops = metas.map((item) => item.background).join("\n");
  useEffect(() => {
    for (const url of backdrops.split("\n")) preloadArtwork(url, "backdrop", device);
  }, [backdrops, device]);

  useEffect(() => {
    if (held || count < 2 || prefersReducedMotion()) return undefined;
    // From the title on show now, so picking a dot restarts its turn.
    const timer = setTimeout(() => goLater(1), marqueeMs - ease());
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-deps -- `index` restarts the turn.
  }, [held, count, index]);

  if (catalogData.isPending) return <HeroSkeleton size="feature" />;
  const shown = arriving ?? index;
  const meta = metas[shown % Math.max(count, 1)];
  if (!meta) {
    return context.watching[0] ? (
      <WatchingHero entry={context.watching[0]} surprise={surprise} {...context} />
    ) : null;
  }
  // Past two titles, every slide stays mounted (see below); with two, the
  // other one is both neighbours, so the slots take turns.
  const slides =
    count > 2
      ? metas.map((item, at) => {
          const rel = (at - index + count) % count;
          return { item, key: item.id, rel: rel > count / 2 ? rel - count : rel };
        })
      : ([-1, 0, 1] as const).flatMap((slot) => {
          const item = metas[(index + slot + count) % count];
          return item ? [{ item, key: String(slot), rel: slot }] : [];
        });
  const entry = context.watching.find((progress) => progress.contentId === meta.id);
  const actions = (
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
  );
  return (
    <div
      ref={frame}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onPointerDown={(event) => {
        if (count < 2 || settling.current || (event.pointerType === "mouse" && event.button !== 0))
          return;
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          at: performance.now(),
          on: false,
        };
        dragged.current = false;
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || state.id !== event.pointerId) return;
        const dx = event.clientX - state.x;
        if (!state.on) {
          if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(event.clientY - state.y)) return;
          state.on = true;
          dragged.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        const width = frame.current?.clientWidth ?? 0;
        place(Math.max(-width, Math.min(width, dx)));
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onClickCapture={(event) => {
        // A drag that ends on a button isn't a press.
        if (!dragged.current) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragStart={(event) => event.preventDefault()}
      className="relative touch-pan-y overflow-x-clip select-none"
    >
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
      <EagerArtwork value>
        <div
          ref={track}
          className="flex will-change-transform"
          style={{ transform: "translateX(-100%)" }}
        >
          {slides.map(({ item, key, rel }) => {
            const here = rel === 0;
            return (
              <div
                key={key}
                inert={!here}
                aria-hidden={!here || undefined}
                // Slides keep their place in the DOM and are lined up with CSS
                // `order`: moving a node restarts its animations and reloads
                // its image, which flashed. Those out of reach wait, unseen, at the end.
                style={{ order: Math.abs(rel) <= 1 ? rel : 10 }}
                className={cn("w-full shrink-0", Math.abs(rel) > 1 && "invisible")}
              >
                <Hero
                  size="feature"
                  title={item.name}
                  logo={item.logo}
                  eyebrow={row.title}
                  meta={metaLine(item)}
                  synopsis={item.description}
                  backdrop={item.background}
                  // Only keeps the room the real buttons, over the slides, take.
                  actions={
                    <span className="contents invisible" inert aria-hidden>
                      {actions}
                    </span>
                  }
                />
              </div>
            );
          })}
        </div>
      </EagerArtwork>
      {/* The buttons and dashes stay put over the slides; only what they
          show changes (the dashes animate between titles). Laid out like
          the Hero's own bottom row, so they sit where its actions would. */}
      <div className="dark pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className="flex w-full items-end justify-between gap-8 px-page pb-14 ios-compact:flex-col ios-compact:items-start ios-compact:gap-5 ios-compact:pb-10">
          <div className="pointer-events-auto flex max-w-2xl flex-wrap items-center gap-2.5 ios-compact:w-full ios-compact:flex-nowrap">
            {actions}
          </div>
          {count > 1 && (
            <div className="pointer-events-auto shrink-0 pb-1">
              <MarqueeDots count={count} index={shown} onPick={pick} titles={metas} held={held} />
            </div>
          )}
        </div>
      </div>
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
          data-marquee-dot
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
    <Button size="xl" variant="light" className="min-w-36 ios-compact:min-w-0" onClick={onClick}>
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

const shapeOf = (meta: MetaPreview) =>
  meta.posterShape === "landscape" ? ("landscape" as const) : ("poster" as const);

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
  const client = useQueryClient();
  const device = useArtworkDevice();
  const { addon, catalog } = row.source;
  const catalogData = useQuery(catalogQuery(addon.url, catalog.type, catalog.id));
  const anime = posterAddon !== undefined && isAnimeCatalog(row.source);
  // An anime catalog's entries as the poster addon's titles, one card per
  // show (lib/anime-titles.ts), once they're answered.
  const listed = catalogData.data?.metas ?? [];
  const { follow, waiting } = useFollowAnime(anime ? posterAddon : undefined, listed);
  if (catalogData.isPending || listed.some((meta) => waiting(meta.id))) return <RowSkeleton />;
  const leaveOut = leaveOutOf(row, leaveOutAnime);
  const metas = followAll(listed, follow).filter(
    (meta) => (!hideUnreleased || isReleased(meta)) && !leaveOut(meta.id),
  );
  if (metas.length === 0) return null;
  // Ten titles and a link to the rest, where a browse page has the catalog.
  const target = browseTarget(row.source);
  const items = target ? metas.slice(0, homeRowLimit) : metas;
  // The art the row's first cards will show, before it scrolls in: for an
  // anime catalog, the poster addon's where there is one.
  const preload = () => {
    for (const meta of items.slice(0, homeRowLimit)) {
      const shape = shapeOf(meta);
      if (anime && shape === "poster") {
        prefetchAnimePoster(client, posterAddon, meta)
          .then((poster) => preloadArtwork(poster ?? meta.poster, "poster", device))
          .catch(() => preloadArtwork(meta.poster, "poster", device));
      } else {
        preloadArtwork(meta.poster, shape, device);
      }
    }
  };
  return (
    <DeferredRow shape={items[0] ? shapeOf(items[0]) : "poster"} preload={preload}>
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
        items={items}
        getKey={(meta) => meta.id}
        card={(meta) => (meta.posterShape === "landscape" ? "landscape" : "poster")}
        renderItem={(meta) => {
          if (anime && meta.posterShape !== "landscape") {
            return <AnimeTitleCard meta={meta} posterAddon={posterAddon} />;
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
    </DeferredRow>
  );
}

// A collection's folders, as tiles. One opens as a merged grid (#96).
function CollectionRow({ row }: { row: Extract<HomeRow, { kind: "collection" }> }) {
  const navigate = useNavigate();
  const device = useArtworkDevice();
  const { collection } = row;
  const folders = collection.folders ?? [];
  if (folders.length === 0) return null;
  const shape = (folder: (typeof folders)[number]) =>
    folder.shape === "POSTER" ? ("poster" as const) : ("landscape" as const);
  return (
    <DeferredRow
      shape={folders[0] ? shape(folders[0]) : "landscape"}
      preload={() => {
        for (const folder of folders.slice(0, homeRowLimit)) {
          preloadArtwork(folder.cover || folder.backdrop, shape(folder), device);
        }
      }}
    >
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
    </DeferredRow>
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
