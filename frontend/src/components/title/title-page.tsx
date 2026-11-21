import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouterState } from "@tanstack/react-router";
import {
  ArrowDown,
  Check,
  Clapperboard,
  Eye,
  EyeOff,
  Film,
  Play,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Profile, WatchedItem } from "@bindings/store";
import { Notice } from "@/components/browse/browse-page";
import { Hero, HeroSkeleton, ImdbScore, MetaLine } from "@/components/media/hero";
import { usePullToRefresh } from "@/components/shell/pull-to-refresh";
import { About } from "@/components/title/about";
import { BackButton } from "@/components/title/back-button";
import { CastList } from "@/components/title/cast-list";
import { Episodes } from "@/components/title/episodes";
import { RoundAction } from "@/components/title/round-action";
import { TitleMoreMenu } from "@/components/title/title-more";
import { TrackingActions } from "@/components/title/tracking-actions";
import { RelatedRows } from "@/components/title/related-rows";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ContentType, Meta, Video } from "@/lib/addon-protocol";
import {
  downloadState,
  pressDownload,
  useTitleDownloads,
  videoToDownload,
  type DownloadState,
  type TitleDownloads,
} from "@/lib/download-pick";
import { downloadLabel, percent, statusOf } from "@/lib/downloads";
import { endsAt, endsAtLabel, remainingSeconds, useClock } from "@/lib/ends-at";
import { useLoadedAddons } from "@/lib/home";
import { libraryQuery } from "@/lib/library";
import { openURL } from "@/lib/open-url";
import { usePlay } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import { warmRanking } from "@/lib/ranking";
import {
  cachedTitleMeta,
  episodeMarks,
  episodeTarget,
  episodes as episodesOf,
  isSeriesType,
  libraryItem,
  mainEpisodes,
  playChoice,
  titleMark,
  titleMetaQuery,
  titleProgressQuery,
  titleState,
  titleWatchedQuery,
  type Episode,
  type PlayChoice,
  type TitlePreview,
  type TitleState,
} from "@/lib/title";
import { useSpoilers } from "@/lib/spoilers";
import { useTitleEdits } from "@/lib/title-actions";
import { useCompactShell } from "@/lib/shell-mode";
import { tmdbRef, useTmdbArt, type TmdbArt } from "@/lib/tmdb";

// A title's page (#45, redesigned in #117): its art under the material-pop chrome,
// details and cast, Play or Resume, the library and watched toggles, and for
// a series its seasons and episodes. It paints from the card it was opened
// from, then from the details' cache, then fills in. Watched state follows
// Nuvio's apps (ADR-0029). With a TMDB key, TMDB's logo, backdrop and cast
// photos replace the addon's (ADR-0031).
export function TitlePage() {
  const { type, id } = useParams({ from: "/title/$type/$id" });
  const profile = useQuery(currentProfileQuery).data;
  const passed = useRouterState({ select: (state) => state.location.state.title });
  const preview = passed?.id === id && passed.type === type ? passed : undefined;
  // The hero, for the Back button to watch scroll away.
  const [hero, setHero] = useState<HTMLElement | null>(null);

  return (
    <div className="relative flex flex-col gap-14 pb-20">
      <BackButton hero={hero} />
      {profile ? (
        <Title profile={profile} type={type} id={id} preview={preview} heroRef={setHero} />
      ) : (
        <HeroSkeleton size="title" />
      )}
    </div>
  );
}

function Title({
  profile,
  type,
  id,
  preview,
  heroRef,
}: {
  profile: Profile;
  type: ContentType;
  id: string;
  preview: TitlePreview | undefined;
  heroRef: (hero: HTMLElement | null) => void;
}) {
  const client = useQueryClient();
  const { visible, addons, loading } = useLoadedAddons(profile.id);
  const details = useQuery({
    ...titleMetaQuery(addons, type, id),
    enabled: !loading,
    // A title seen before: its details from the cache at once.
    ...cachedTitleMeta(client, addons, type, id),
  });

  const meta = details.data?.meta;
  // An IMDb or TMDB id is looked up at once, beside the addon; a Kitsu id
  // waits for the details' imdb_id.
  const art = useTmdbArt(tmdbRef(type, id, meta));
  // Pull to refresh on iOS (#135): the addon's details and TMDB's.
  usePullToRefresh(() =>
    Promise.all([
      details.refetch(),
      client.invalidateQueries({ queryKey: ["tmdb"], refetchType: "active" }),
    ]),
  );
  // Play is a click away: get the ranking engine's slow first run over.
  useEffect(warmRanking, []);
  const shown = meta ?? preview;
  if (!shown) {
    if (details.isError || visible.data?.length === 0) {
      return <LoadFailed onRetry={() => void details.refetch()} />;
    }
    return <HeroSkeleton size="title" />;
  }
  return (
    <>
      {meta && details.data ? (
        <LoadedTitle
          profile={profile}
          meta={meta}
          addonUrl={details.data.addonUrl}
          art={art}
          heroRef={heroRef}
        />
      ) : (
        <Hero
          ref={heroRef}
          size="title"
          title={shown.name}
          logo={art?.logo}
          meta={shown.releaseInfo ? [<span key="year">{shown.releaseInfo}</span>] : []}
          synopsis={shown.description}
          {...backdrops(shown, art)}
        />
      )}
      {!meta && details.isError && <LoadFailed onRetry={() => void details.refetch()} />}
    </>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="pt-16">
      <Notice
        icon={Clapperboard}
        title="Couldn’t load this title"
        description="None of your addons answered for it. They may be down, or you may be offline."
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    </div>
  );
}

function LoadedTitle({
  profile,
  meta,
  addonUrl,
  art,
  heroRef,
}: {
  profile: Profile;
  meta: Meta;
  addonUrl: string;
  art: TmdbArt | undefined;
  heroRef: (hero: HTMLElement | null) => void;
}) {
  const play = usePlay();
  // The phone's one action row (#136): Play, Library, Watched, then "•••".
  const compact = useCompactShell();
  const marks = useQuery(titleWatchedQuery(profile.id, meta.id)).data ?? [];
  const progress = useQuery(titleProgressQuery(profile.id, meta.id)).data ?? [];
  const library = useQuery(libraryQuery(profile.id)).data;
  const state = titleState(meta, marks, progress);
  const choice = playChoice(meta, state, progress);
  const series = isSeriesType(meta.type);
  const list = episodesOf(meta);
  // "Ends at 10:42 PM" for what Play plays, kept current as the clock turns.
  const now = useClock();
  const spoilers = useSpoilers(profile.id);
  const ends = choice ? endsAtFor(meta, choice, state, list, now) : undefined;
  const saved = library?.some(
    (item) => item.contentId === meta.id && item.contentType === meta.type,
  );

  const { setWatched, saveToLibrary, removeFromLibrary, clearProgress } = useTitleEdits(profile.id);
  // The title's downloads (#85): one queue for the page, shared by the
  // Download action and the episode rows.
  const downloads = useTitleDownloads(profile.id);
  // What the Download action downloads: a film itself, or the episode Play
  // would play. A series with nothing to play has nothing to download.
  const { video: downloadVideo, canDownload } = videoToDownload(
    meta,
    choice?.target.videoId,
    series,
  );
  const mark = (items: WatchedItem[], watched: boolean) =>
    setWatched.mutate({ meta, items, watched });
  const toggleLibrary = () =>
    saved
      ? removeFromLibrary.mutate({ contentId: meta.id, contentType: meta.type, name: meta.name })
      : saveToLibrary.mutate(libraryItem(meta, addonUrl));

  const watched = series ? state.seriesWatched : state.watched();
  const toggleWatched = () => {
    if (!series) return mark([titleMark(meta)], !watched);
    return mark([titleMark(meta), ...episodeMarks(meta, mainEpisodes(list))], !watched);
  };

  return (
    <>
      <Hero
        ref={heroRef}
        size="title"
        // The hero's fade already ends at its bottom edge, so the page's own
        // gap would show as a blank band under it (worst in light mode).
        className="-mb-8"
        title={meta.name}
        logo={art?.logo ?? meta.logo}
        meta={[<TitleMeta key="meta" meta={meta} art={art} compact={compact} ends={ends} />]}
        metaRaw
        synopsis={meta.description}
        {...backdrops(meta, art)}
        actions={
          <>
            {choice && (
              <Button
                size="xl"
                variant="light"
                className="min-w-40 ios-compact:min-w-0 ios-compact:flex-1"
                onClick={() => play(choice.target)}
              >
                {choice.resume ? <RotateCcw /> : <Play className="fill-current" />}
                {choice.label}
              </Button>
            )}
            <RoundAction
              label={saved ? "In library" : "Add to library"}
              disabled={
                library === undefined || saveToLibrary.isPending || removeFromLibrary.isPending
              }
              onClick={toggleLibrary}
            >
              {saved ? <Check /> : <Plus />}
            </RoundAction>
            <RoundAction
              label={watched ? "Watched" : "Mark watched"}
              disabled={setWatched.isPending || (series && mainEpisodes(list).length === 0)}
              onClick={toggleWatched}
            >
              {watched ? <EyeOff /> : <Eye />}
            </RoundAction>
            {/* The phone keeps it in "•••" (#136): the row has no room for a
                fifth round action. */}
            {canDownload && !compact && (
              <DownloadAction
                downloads={downloads}
                meta={meta}
                metaAddon={addonUrl}
                video={downloadVideo}
              />
            )}
            {compact && (
              <TitleMoreMenu
                profile={profile}
                meta={meta}
                trailer={art?.trailer}
                watched={watched}
                markDisabled={setWatched.isPending || (series && mainEpisodes(list).length === 0)}
                onToggleWatched={toggleWatched}
                download={
                  canDownload
                    ? { downloads, meta, metaAddon: addonUrl, video: downloadVideo }
                    : undefined
                }
              />
            )}
            {!compact && <TrackingActions profile={profile} meta={meta} />}
            {/* YouTube opens in the system browser; the player isn't involved.
                A kids profile doesn't leave the app. */}
            {!compact && art?.trailer && !profile.kids && (
              <RoundAction
                label="Trailer"
                disabled={false}
                onClick={() => void openURL(art.trailer!)}
              >
                <Film />
              </RoundAction>
            )}
          </>
        }
      />
      {series && list.length > 0 && (
        <Episodes
          meta={meta}
          list={list}
          state={state}
          next={choice?.target.videoId}
          busy={setWatched.isPending}
          download={{ downloads, metaAddon: addonUrl }}
          onMark={mark}
          onPlay={(episode) =>
            play(episodeTarget(meta, episode, state.progress(episode)?.position))
          }
          onPlayFromStart={(episode) => play({ ...episodeTarget(meta, episode), startOver: true })}
          spoilers={{
            hidden: (episode) =>
              spoilers.hidden(
                episode.id,
                state.watched(episode),
                state.progress(episode) !== undefined,
              ),
            reveal: (episode) => spoilers.reveal(episode.id),
          }}
          onClearProgress={(episode) => {
            const entry = state.progress(episode);
            if (entry) clearProgress.mutate({ contentId: meta.id, keys: [entry.key] });
          }}
        />
      )}
      {art && art.cast.length > 0 && <CastList cast={art.cast} />}
      <About meta={meta} withCast={!art || art.cast.length === 0} art={art} />
      {art && !profile.kids && <RelatedRows art={art} />}
      {/* Ranks the streams of whatever this page queued for download, and
          leaves once it's added. */}
      {downloads.queue.runner}
    </>
  );
}

// The title page's Download (#85): the film itself, or the episode Play would
// play. Download → Finding a stream… → Queued, a percent, or Downloaded; a
// paused or failed one resumes, and a finished one is removed after a yes.
function DownloadAction({
  downloads,
  meta,
  metaAddon,
  video,
}: {
  downloads: TitleDownloads;
  meta: Meta;
  metaAddon: string;
  video?: Video | undefined;
}) {
  const state = downloadState(downloads, meta, metaAddon, video);
  const [removing, setRemoving] = useState<DownloadState["download"]>(undefined);
  return (
    <>
      <RoundAction
        label={state.control.label}
        disabled={false}
        onClick={() =>
          pressDownload(state, downloads, (download) => setRemoving(download))
        }
      >
        <DownloadGlyph state={state} />
      </RoundAction>
      <RemoveDownloadDialog
        download={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        onConfirm={() => {
          if (removing) void downloads.actions.remove([removing.id]);
          setRemoving(undefined);
        }}
      />
    </>
  );
}

// What the round action shows: an arrow down for what's to come, a percent
// while it runs, a check once downloaded, and the resume arrow for one that
// stopped.
function DownloadGlyph({ state }: { state: DownloadState }) {
  const { download } = state;
  if (download) {
    const status = statusOf(download);
    if (status === "done") return <Check aria-hidden />;
    if (status === "paused" || status === "failed") return <RotateCcw aria-hidden />;
    const done = percent(download);
    if (status === "downloading" && done !== undefined) {
      return (
        <span aria-hidden className="text-[0.6875rem] font-[650] tnum">
          {done}%
        </span>
      );
    }
  }
  return <ArrowDown aria-hidden />;
}

// Asked before a downloaded file is deleted: a partial one goes without
// asking, since there is nothing finished to lose.
function RemoveDownloadDialog({
  download,
  onOpenChange,
  onConfirm,
}: {
  download: DownloadState["download"];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={download !== undefined} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove the download?</AlertDialogTitle>
          <AlertDialogDescription>
            {download
              ? `${downloadLabel(download)} is deleted from this device. You can download it again from the stream list.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={onConfirm}>
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

// When what Play plays would end if started now: a film from its runtime
// (or what's left of it), a series' next episode from its own runtime, else
// the series'. Nothing when the runtime isn't known.
function endsAtFor(
  meta: Meta,
  choice: PlayChoice,
  state: TitleState,
  list: readonly Episode[],
  now: number,
): string | undefined {
  const episode = isSeriesType(meta.type)
    ? list.find((each) => each.id === choice.target.videoId)
    : undefined;
  if (isSeriesType(meta.type) && !episode) return undefined;
  const own = typeof episode?.["runtime"] === "string" ? episode["runtime"] : undefined;
  const left = remainingSeconds(own ?? meta.runtime, state.progress(episode));
  const end = left === undefined ? undefined : endsAt(now, left);
  return end === undefined ? undefined : endsAtLabel(end);
}

// TMDB's backdrop over the addon's, which shows while it loads or if it
// fails.
function backdrops(
  shown: { background?: string | undefined; poster?: string | undefined },
  art: TmdbArt | undefined,
) {
  const own = shown.background ?? shown.poster;
  return art?.backdrop
    ? { backdrop: art.backdrop, fallbackBackdrop: own }
    : { backdrop: own, fallbackBackdrop: undefined };
}

// "2008–2013 · 49 min · Crime, Drama, Thriller · TV-MA · IMDb 8.4 · TMDB 8.9".
export function TitleMeta({
  meta,
  art,
  compact = false,
  ends,
}: {
  meta: Meta;
  art: TmdbArt | undefined;
  compact?: boolean;
  // "Ends at 10:42 PM", last on the line.
  ends?: string | undefined;
}) {
  const endsItem = ends && (
    <span key="ends" data-testid="ends-at" className="whitespace-nowrap tnum">
      {ends}
    </span>
  );
  // The phone has one line: year · ends at · genres · IMDb (#136).
  if (compact) {
    const phone = [meta.releaseInfo, (meta.genres ?? []).slice(0, 2).join(", ")]
      .filter(Boolean)
      .map((text) => <span key={text}>{text}</span>);
    if (meta.imdbRating) phone.push(<ImdbScore key="imdb" rating={meta.imdbRating} />);
    else if (art?.score) phone.push(<TmdbScore key="tmdb" rating={art.score} />);
    // Second, so a narrow line clips the genres rather than the time.
    if (endsItem) phone.splice(meta.releaseInfo ? 1 : 0, 0, endsItem);
    return <MetaLine items={phone} className="flex-nowrap overflow-hidden text-[0.8125rem]" />;
  }
  const items = [meta.releaseInfo, meta.runtime, (meta.genres ?? []).slice(0, 3).join(", ")]
    .filter(Boolean)
    .map((text) => <span key={text}>{text}</span>);
  if (art?.certificate) {
    items.push(
      <span
        key="certificate"
        data-testid="certificate"
        className="rounded-[3px] px-1 py-px text-[0.6875rem] leading-none font-semibold text-white/85 ring-1 ring-white/45"
      >
        {art.certificate}
      </span>,
    );
  }
  if (meta.imdbRating) items.push(<ImdbScore key="imdb" rating={meta.imdbRating} />);
  if (art?.score) items.push(<TmdbScore key="tmdb" rating={art.score} />);
  if (endsItem) items.push(endsItem);
  return <MetaLine items={items} className="text-[0.8125rem]" />;
}

// TMDB's own teal tag, then the score.
function TmdbScore({ rating }: { rating: string }) {
  return (
    <span data-testid="tmdb-score" className="inline-flex items-center gap-1.5">
      <span className="rounded-[3px] bg-[#01b4e4] px-1 py-px text-[0.5625rem] leading-none font-black tracking-tight text-black">
        TMDB
      </span>{" "}
      {rating}
    </span>
  );
}
