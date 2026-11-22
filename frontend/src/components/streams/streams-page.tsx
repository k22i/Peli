import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Puzzle,
  RotateCw,
  Users,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Profile } from "@bindings/store";
import { Service as Sync } from "@bindings/syncer";
import { Notice } from "@/components/browse/browse-page";
import { Artwork } from "@/components/media/artwork";
import { useArtUnderBar } from "@/components/shell/bar-tone";
import { ScrollRail } from "@/components/media/scroll-rail";
import { listRows, StreamList } from "@/components/streams/stream-list";
import { filteredListProps, type Filtering } from "@/components/streams/stream-toolbar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { feature } from "@/lib/features";
import { isIOS } from "@/lib/platform";
import { useCompactShell } from "@/lib/shell-mode";
import { toastManager } from "@/components/ui/toast";
import { streamsQuery, type ContentType, type Stream } from "@/lib/addon-protocol";
import { chosenSourceQuery, remembered, rememberSource } from "@/lib/chosen-source";
import { useEpisodeMap } from "@/lib/episode-map";
import { useLoadedAddons } from "@/lib/home";
import { playableQuery, type Playable } from "@/lib/downloads";
import {
  loadDownloaded,
  playerState,
  streamId,
  streamsPath,
  streamsSearch,
  type PlayTarget,
  type StreamsSearch,
} from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import {
  rememberedMatch,
  runtimeMinutes,
  titleContext,
  type Candidate,
  type Tier,
} from "@/lib/ranking";
import { loadOptions, Player } from "@/lib/player";
import {
  matchesPartySource,
  Party,
  partyWatches,
  useParty,
  type PartyInfo,
  type SharedStream,
} from "@/lib/party";
import { playSharedStream } from "@/lib/party-pick";
import { attempts, PlayError, resolvePick } from "@/lib/resolve";
import { isPluginSource, pluginSource, pluginStreamsQuery } from "@/lib/plugins";
import { usePreResolve, useSettled } from "@/lib/pre-resolve";
import {
  audioLanguagesOf,
  deviceSettingsQuery,
  languageName,
  profileSettingsQuery,
  useSaveDeviceSettings,
} from "@/lib/settings";
import {
  facetChips,
  filtersKey,
  filtersLabel,
  filterView,
  isFiltered,
  isStreamSort,
  keepForSession,
  offered,
  sessionFilters,
  sortsAvailable,
  toggle,
  type StreamFilters,
  type StreamSort,
} from "@/lib/stream-filters";
import {
  rankingPrefs,
  usePluginSources,
  useRankedStreams,
  useStreamAddons,
  useStreams,
  type StreamSource,
} from "@/lib/streams";
import { resolutionLabel } from "@/lib/stream-labels";
import { neighbours, neighbourTarget } from "@/lib/stream-episodes";
import { subtitleTarget } from "@/lib/subtitles";
import { tmdbRef, useTmdbAliases, useTmdbArt } from "@/lib/tmdb";
import { Torrents, torrentStatusText } from "@/lib/torrent";
import {
  cachedTitleMeta,
  episodeCode,
  isSeriesType,
  type Episode,
  playerHeading,
  resumePoint,
  titleMetaQuery,
  titleProgressQuery,
  watchingFor,
} from "@/lib/title";

// The stream picker: every stream addon asked at once, each with its own
// state (#50), and their streams ranked as they arrive (#51) and shown by
// quality (#52): the top pick first, one key (P) to play it, and likely
// fakes and CAM / TS collapsed. Leaving it aborts the requests still out.
// Picking a stream resolves its link, or another copy's (#53), or streams
// its torrent (#55), and plays it (#60) from where the profile left it, as
// synced (#64). A show's top pick is the closest match to the source it
// last played from (#58), and what plays is remembered as that source.
export function StreamsPage() {
  const { type, id } = useParams({ from: "/streams/$type/$id" });
  const search: StreamsSearch = useSearch({ from: "/streams/$type/$id" });
  const profile = useQuery(currentProfileQuery).data;
  const passed = useRouterState({ select: (state) => state.location.state.play });
  const video = streamId({ id, videoId: search.video });
  const target: PlayTarget =
    passed?.id === id && streamId(passed) === video
      ? passed
      : { type, id, title: "Streams", videoId: search.video, resumeAt: search.at };

  return (
    // `isolate` holds the Ambient art behind the page.
    <div className="relative isolate flex flex-col gap-6 pb-16">
      {profile ? (
        <Picker
          key={`${type}/${video}`}
          profile={profile}
          type={type}
          video={video}
          target={target}
        />
      ) : (
        <>
          <PageHeader title={target.title} />
          <Asking />
        </>
      )}
    </div>
  );
}

// A banner of the title's art under the top bar: Back, "Choose a source",
// the title in the display serif and, for an episode, its number and name.
// The `h1` is always the title the picker was opened with.
function PageHeader({
  title,
  episode,
  backdrop,
  steps,
}: {
  title: string;
  episode?: string | undefined;
  backdrop?: string | undefined;
  steps?: EpisodeStepsProps | undefined;
}) {
  useArtUnderBar(backdrop !== undefined);
  const compact = useCompactShell();
  // The phone (#136): no hero. Back is in the top bar, and a 56 pt strip of
  // blurred art under it holds "Streams" and what it is for.
  if (compact) {
    return (
      <header
        className={cn(
          "relative isolate [--fade:var(--background)]",
          backdrop && "dark under-bar text-foreground",
        )}
      >
        {backdrop && (
          <>
            <Artwork
              src={backdrop}
              use="backdrop"
              title={title}
              className="absolute inset-0 -z-10 scale-125 blur-2xl"
            />
            <div className="absolute inset-0 -z-10 bg-black/55" />
            <div className="absolute inset-x-0 bottom-0 -z-10 h-6 bg-linear-to-t from-(--fade) to-transparent" />
          </>
        )}
        <div
          className={cn(
            "flex h-14 flex-col justify-center px-page",
            backdrop && "mt-(--spacing-bar)",
          )}
        >
          <h1 className="text-[1.375rem] leading-tight font-[650] tracking-[-0.015em]">
            Streams<span className="sr-only"> · {title}</span>
          </h1>
          <p className="truncate text-[0.8125rem] text-foreground/75">{episode ?? title}</p>
        </div>
        {steps && (
          <div className="absolute inset-y-0 end-3 flex items-center">
            <EpisodeSteps {...steps} overArt={backdrop !== undefined} compact />
          </div>
        )}
      </header>
    );
  }
  return (
    <header
      className={cn(
        "relative isolate [--fade:var(--background)]",
        backdrop && "dark under-bar text-foreground",
      )}
    >
      {backdrop && (
        <>
          <Artwork src={backdrop} use="backdrop" title={title} className="absolute inset-0 -z-10" />
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(110%_120%_at_0%_100%,rgb(0_0_0/0.85),rgb(0_0_0/0.4)_55%,rgb(0_0_0/0.15))]" />
          <div className="absolute inset-x-0 bottom-0 -z-10 h-24 bg-linear-to-t from-(--fade) to-transparent" />
        </>
      )}
      <div
        className={cn(
          "flex items-end gap-5 px-page",
          backdrop ? "min-h-[min(40vh,22rem)] pt-[calc(var(--spacing-bar)+1rem)] pb-10" : "pt-2",
        )}
      >
        <BackButton overArt={backdrop !== undefined} />
        <div className="flex min-w-0 flex-col gap-2">
          <p className={cn("type-eyebrow", backdrop ? "text-[#ffc46b]" : "text-sun-ink")}>
            Choose a source
          </p>
          <h1 className="type-display text-balance">{title}</h1>
          {episode && <p className="text-[0.9375rem] text-foreground/75">{episode}</p>}
          {steps && <EpisodeSteps {...steps} overArt={backdrop !== undefined} />}
        </div>
      </div>
    </header>
  );
}

type EpisodeStepsProps = {
  previous?: Episode | undefined;
  next?: Episode | undefined;
  go: (episode: Episode) => void;
};

// Previous and next episode, for a series: each names its episode.
export function EpisodeSteps({
  previous,
  next,
  go,
  overArt = false,
  compact = false,
}: EpisodeStepsProps & { overArt?: boolean; compact?: boolean }) {
  if (!previous && !next) return null;
  const variant = overArt ? "media" : "secondary";
  return (
    <nav aria-label="Episodes" className="mt-1 flex items-center gap-2">
      {previous && (
        <Button
          size="sm"
          variant={variant}
          className="rounded-full"
          aria-label={`Previous episode, ${episodeCode(previous)}`}
          onClick={() => go(previous)}
        >
          <ChevronLeft aria-hidden />
          {compact ? null : <>Previous · {episodeCode(previous)}</>}
        </Button>
      )}
      {next && (
        <Button
          size="sm"
          variant={variant}
          className="rounded-full"
          aria-label={`Next episode, ${episodeCode(next)}`}
          onClick={() => go(next)}
        >
          {compact ? null : <>Next · {episodeCode(next)}</>}
          <ChevronRight aria-hidden />
        </Button>
      )}
    </nav>
  );
}

function BackButton({ overArt = false }: { overArt?: boolean }) {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return (
    <Button
      variant={overArt ? "media" : "secondary"}
      size="icon-lg"
      aria-label="Back"
      onClick={() => (canGoBack ? router.history.back() : void navigate({ to: "/" }))}
      className="mb-1 shrink-0"
    >
      <ChevronLeft className="size-5" strokeWidth={2.25} />
    </Button>
  );
}

function Asking() {
  return (
    <div className="flex justify-center py-12">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

function Picker({
  profile,
  type,
  video,
  target,
}: {
  profile: Profile;
  type: ContentType;
  video: string;
  target: PlayTarget;
}) {
  const {
    loading,
    answered,
    sources,
    names,
    meta,
    settings,
    device,
    view,
    ranked,
    pin,
    rows,
    toggleGroup,
    refresh,
    usual,
    filtering,
    sourceFilter,
  } = useStreamChoices(profile.id, type, target.id, video, target.title);
  const client = useQueryClient();
  // "Start cached streams sooner" (#101, ADR-0060): the top pick resolves
  // while the user looks, when it's a cached debrid stream. Never for a
  // kids profile: it adds to the parent's debrid list.
  // The filtered top pick, once the filters have stayed put a moment: a
  // run of chip toggles resolves nothing on the way.
  const settledTop = useSettled(view.top, filtersKey(filtering.filters), filtersSettle);
  // A finished download plays before anything is resolved (ADR-0064): with
  // one, nothing resolves ahead either.
  const downloaded = useQuery(playableQuery(profile.id, video));
  const ahead = usePreResolve(settledTop, {
    enabled:
      device?.preResolve === true && !profile.kids && !downloaded.isPending && !downloaded.data,
    answered,
    refresh,
  });
  const navigate = useNavigate();
  // The watch party, when it watches this (ADR-0051): its host's stream and
  // source are offered first, and what's picked starts where the party is.
  const partyState = useParty();
  const forParty = partyWatches(partyState?.party, type, target.id, video)
    ? (partyState?.party ?? undefined)
    : undefined;
  // The title's backdrop, as its page shows it (TMDB's with a key, else the
  // addon's), from the cache when the page was seen. It tints the top.
  const art = useTmdbArt(tmdbRef(type, target.id, meta));
  const backdrop = art?.backdrop ?? meta?.background ?? meta?.poster;
  // The episodes either side: another one's picker, in place of this.
  const near = neighbours(meta, video);
  const goTo = (episode: Episode) => {
    if (!meta) return;
    const picked = neighbourTarget(meta, episode);
    void navigate({
      to: streamsPath,
      params: { type: picked.type, id: picked.id },
      search: streamsSearch({ video: picked.videoId }),
      state: (current) => ({ ...current, play: picked }),
      replace: true,
    });
  };
  const header = (
    <PageHeader
      title={target.title}
      episode={playerHeading(meta, video, target.title).episode}
      backdrop={backdrop}
      steps={{ previous: near.previous, next: near.next, go: goTo }}
    />
  );
  // Where it was left may have moved on another device: pull while the
  // user picks (Go skips it if it pulled in the last half minute).
  useEffect(() => {
    Sync.Pull().catch(() => {});
  }, []);

  // Resolving the pick (#53): one at a time, so a second pick replaces the
  // first, and none once the picker is left.
  const opening = useRef<{ controller: AbortController; toast: string }>(null);
  useEffect(
    () => () => {
      if (!opening.current) return;
      opening.current.controller.abort();
      toastManager.close(opening.current.toast);
    },
    [],
  );
  // A finished download of this video plays as it is, whatever was picked:
  // no resolve, no network (ADR-0064).
  const playDownloaded = async (playable: Playable) => {
    const partyAt = forParty ? await Party.StartAt(forParty.media).catch(() => -1) : -1;
    try {
      const player = await loadDownloaded({
        client,
        profileId: profile.id,
        target,
        playable,
        meta,
        settings,
        at: partyAt >= 0 ? partyAt : undefined,
      });
      void navigate({
        to: "/player",
        // iOS: the player takes the picker's place, so Back and close land
        // on the title.
        replace: isIOS(),
        state: (state) => ({ ...state, player }),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: `Can’t play ${target.title}`,
        description: "Peli’s player couldn’t start. Try again, or restart Peli.",
        timeout: 8000,
      });
    }
  };
  const pick = (candidate: Candidate) => {
    pin();
    void client
      .fetchQuery(playableQuery(profile.id, video))
      .catch(() => null)
      .then((playable) => (playable ? playDownloaded(playable) : pickStream(candidate)));
  };
  const pickStream = (candidate: Candidate) => {
    pin();
    if (opening.current) {
      opening.current.controller.abort();
      toastManager.close(opening.current.toast);
    }
    const controller = new AbortController();
    const quality = resolutionLabel(candidate.parsed) ?? "the stream";
    // Cancel stops the resolve and leaves the picker as it was.
    const cancel = () => {
      controller.abort();
      toastManager.close(toast);
      if (opening.current === current) opening.current = null;
    };
    const toast = toastManager.add({
      type: "loading",
      title: `Opening ${quality} from ${names.get(candidate.source) ?? "an addon"}…`,
      timeout: 0,
      actionProps: { children: "Cancel", onClick: cancel },
    });
    const current = { controller, toast };
    opening.current = current;
    // A torrent takes a while to find peers: say how it's going.
    let settled = false;
    const statusTimer =
      feature("torrent") && attempts(candidate).some(({ stream }) => !stream.url && stream.infoHash)
        ? setInterval(() => {
            Torrents.Status()
              .then((status) => {
                if (settled || !status.active) return;
                toastManager.update(toast, { description: torrentStatusText(status) });
              })
              .catch(() => {});
          }, 1000)
        : undefined;
    // The top pick may have resolved already (#101); if that failed, it
    // resolves now, with its copies.
    const resolveNow = () => resolvePick(candidate, { refresh, signal: controller.signal });
    const early = ahead.take(candidate);
    const resolving = early
      ? early.catch(() => {
          controller.signal.throwIfAborted();
          return resolveNow();
        })
      : resolveNow();
    resolving
      .finally(() => {
        settled = true;
        clearInterval(statusTimer);
      })
      .then(
        async ({ source, attempt }) => {
          if (controller.signal.aborted) return;
          // Where it was left, as the store has it now (#64); if the store
          // can't say, where the card said (resumeAt is in ms).
          const progress = await client
            .fetchQuery({ ...titleProgressQuery(profile.id, target.id), staleTime: 0 })
            .catch(() => undefined);
          if (controller.signal.aborted) return;
          const watching = watchingFor(profile.id, target, meta, progress ?? []);
          const partyAt = forParty ? await Party.StartAt(forParty.media).catch(() => -1) : -1;
          if (controller.signal.aborted) return;
          const start =
            partyAt >= 0
              ? partyAt
              : target.startOver
                ? 0
                : progress
                  ? resumePoint(progress, watching)
                  : (target.resumeAt ?? 0) / 1000;
          // The player (#60) takes it from here, in the profile's languages
          // (#62), keeping its progress as it plays (#64).
          void Player.Load(source, loadOptions(start, settings, [], watching)).then(
            () => {
              toastManager.close(toast);
              // What played is the show's source now (#58), the top pick or
              // not: the next episode starts from it.
              rememberSource(client, profile.id, type, target.id, candidate, attempt);
              void navigate({
                to: "/player",
                // iOS: the player takes the picker's place, so Back and
                // close land on the title.
                replace: isIOS(),
                state: (state) => ({
                  ...state,
                  player: playerState({
                    heading: playerHeading(meta, video, target.title),
                    source,
                    watching,
                    start,
                    stream: attempt.stream,
                    subtitles: subtitleTarget(
                      type,
                      video,
                      attempt.stream,
                      names.get(attempt.source) ?? "",
                    ),
                  }),
                }),
              });
            },
            () => {
              toastManager.update(toast, {
                type: "error",
                title: `Can’t play ${target.title}`,
                description: "Peli’s player couldn’t start. Try again, or restart Peli.",
                timeout: 8000,
                actionProps: undefined,
              });
            },
          );
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const failed =
            error instanceof PlayError
              ? error
              : new PlayError("unreachable", candidate.parsed.debrid);
          toastManager.update(toast, {
            type: "error",
            title: failed.message,
            description: failed.description,
            timeout: 8000,
            // Cancel goes; Open Settings stays for a torrent.
            actionProps:
              failed.kind === "torrent"
                ? {
                    children: "Open Settings",
                    onClick: () =>
                      void navigate({ to: "/settings", search: { section: "streaming" } }),
                  }
                : undefined,
          });
        },
      )
      .finally(() => {
        if (opening.current === current) opening.current = null;
      });
  };
  usePlayKey(view.top, pick);

  if (sources.length === 0) {
    if (loading) {
      return (
        <>
          {header}
          <Asking />
        </>
      );
    }
    // An AniList id: AniList knows the title, but the anime list has no
    // Kitsu id for it yet, and stream addons find anime by Kitsu or IMDb id
    // (#108).
    if (video.startsWith("anilist:")) {
      return (
        <>
          {header}
          <div className="pt-12">
            <Notice
              icon={Puzzle}
              title="No streams yet"
              description="Stream addons find anime by its Kitsu or IMDb id, and this one doesn’t have either yet. New titles usually get one within a few days."
            />
          </div>
        </>
      );
    }
    return (
      <>
        {header}
        <div className="pt-12">
          <Notice
            icon={Puzzle}
            title="No addon has streams for this"
            description="None of your enabled addons serves streams for it. Add a stream addon to watch it."
            action={
              <Link to="/addons" className={buttonVariants()}>
                Manage addons
              </Link>
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      {forParty && (
        <PartySources
          party={forParty}
          match={ranked.groups
            .flatMap((group) => group.items)
            .find((candidate) => matchesPartySource(candidate.stream, forParty.media.source))}
          onPick={pick}
          onPlayShared={(shared) =>
            void playSharedStream({
              navigate,
              shared,
              media: forParty.media,
              profileId: profile.id,
              type,
              id: target.id,
              video,
              title: target.title,
              meta,
              settings,
            }).catch(() =>
              toastManager.add({
                type: "error",
                title: `Can’t play ${shared.sharedBy}’s stream`,
                description: "Their link didn’t open here. Choose a stream of your own.",
              }),
            )
          }
        />
      )}
      <StreamsSummary
        sources={sources}
        loading={loading}
        total={ranked.total}
        shown={view.total}
        filter={sourceFilter}
      />
      <StreamList
        rows={rows}
        runtime={runtimeMinutes(meta?.runtime) ?? null}
        names={names}
        onNavigate={pin}
        onPick={pick}
        onToggleGroup={toggleGroup}
        usual={usual}
        {...filteredListProps(filtering, view)}
      />
    </>
  );
}

// How long the filters stay put before the filtered top pick resolves ahead.
const filtersSettle = 1200;

// The ranked streams for one film or episode, as the picker and the
// player's stream switcher (#68) list them, filtered and sorted as the user
// chose (`filtering`, `sourceFilter`): every stream addon asked, and
// their streams ranked as they answer, by what the title's details (as its
// page asked for them, usually cached by now) and the profile's audio
// language say. Ranking starts without the details and starts again once
// they come. The source a show last played from (#58) puts its closest
// match on top, which `usual` tells. `rows` has the collapsed groups that
// toggleGroup opened.
export function useStreamChoices(
  profileId: number,
  type: ContentType,
  id: string,
  video: string,
  title: string,
) {
  const { addons, loading: addonsLoading } = useStreamAddons(profileId);
  const addonSources = useStreams(addons, type, video);
  const client = useQueryClient();
  const browsing = useLoadedAddons(profileId);
  const metaQuery = useQuery({
    ...titleMetaQuery(browsing.addons, type, id),
    enabled: !browsing.loading,
    ...cachedTitleMeta(client, browsing.addons, type, id),
  });
  const meta = metaQuery.data?.meta;
  // Plugins (#56) are asked beside the addons, and ranked with them.
  const plugins = usePluginSources(type, id, video, meta);
  const sources = [...addonSources, ...plugins.sources];
  const loading = addonsLoading || plugins.loading;
  const names = new Map(sources.map((source) => [source.key, source.name]));
  // A fresh answer from the source of an expired link (#53): its addon, or
  // its plugin.
  const refresh = async (source: string): Promise<readonly Stream[]> => {
    if (isPluginSource(source)) {
      const plugin = plugins.plugins.find((p) => pluginSource(p) === source);
      if (!plugin || !plugins.query) return [];
      return client.fetchQuery({ ...pluginStreamsQuery(plugin, plugins.query), staleTime: 0 });
    }
    return (await client.fetchQuery({ ...streamsQuery(source, type, video), staleTime: 0 }))
      .streams;
  };
  const settings = useQuery(profileSettingsQuery(profileId)).data;
  const device = useQuery(deviceSettingsQuery).data;
  const chosenQuery = useQuery({
    ...chosenSourceQuery(profileId, id),
    enabled: isSeriesType(type),
  });
  const chosen = chosenQuery.data;
  const last = isSeriesType(type) ? remembered(chosen) : null;
  const { map, pending: mapPending } = useEpisodeMap(
    browsing.addons,
    browsing.loading,
    type,
    id,
    video,
  );
  // TMDB's other names for the title, from the title page's own request (#99).
  const aliases = useTmdbAliases(tmdbRef(type, id, meta));
  const ctx = titleContext(type, video, meta, title, { map, aliases });
  const prefs = rankingPrefs(settings, device, last);
  const { view: ranked, pin: pinRanked } = useRankedStreams(sources, ctx, prefs);

  // The filters and the sort (the sort is the device's, the filters the
  // session's), applied to the ranked view before its rows are listed.
  const [filters, setFiltersState] = useState<StreamFilters>(sessionFilters);
  const setFilters = (next: StreamFilters) => {
    keepForSession(next);
    setFiltersState(next);
  };
  const saveDevice = useSaveDeviceSettings();
  const candidates = useMemo(() => offered(ranked), [ranked]);
  const sorts = sortsAvailable(candidates);
  const saved: StreamSort = isStreamSort(device?.streamSort) ? device.streamSort : "best";
  const sort = sorts.includes(saved) ? saved : "best";
  const setSort = (next: StreamSort) => {
    if (device) saveDevice.mutate({ ...device, streamSort: next });
  };
  // A top pick the user pinned under each set of filters.
  const [pins, setPins] = useState<ReadonlyMap<string, string>>(new Map());
  const key = filtersKey(filters);
  const pinned = pins.get(key) ?? null;
  const maxResolution = prefs.maxResolution;
  const view = filterView(ranked, filters, sort, { remembered: last, maxResolution, pinned });
  const pin = () => {
    pinRanked();
    const top = view.top;
    if (!isFiltered(filters) || !top) return;
    setPins((current) => (current.has(key) ? current : new Map(current).set(key, top.key)));
  };
  const chipContext = { languages: audioLanguagesOf(settings), languageName, names };
  const chips = facetChips(candidates, filters, chipContext);
  const filtering: Filtering = {
    filters,
    setFilters,
    chips,
    sort,
    sorts,
    setSort,
    label: filtersLabel(filters, chipContext),
  };
  const sourceChips = chips.find((chip) => chip.facet === "source");
  const sourceFilter: SourceFilter | undefined = sourceChips && {
    chosen: filters.chosen.source ?? [],
    toggle: (source) => setFilters(toggle(filters, "source", source)),
  };

  const [open, setOpen] = useState<ReadonlySet<Tier>>(new Set());
  const toggleGroup = (tier: Tier) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(tier)) next.add(tier);
      return next;
    });
  // Every source has answered, and what ranks them has loaded: the top
  // pick only changes now if the user moves it.
  const answered =
    !loading &&
    sources.every((source) => source.status !== "pending") &&
    !browsing.loading &&
    !metaQuery.isPending &&
    !mapPending &&
    !(isSeriesType(type) && chosenQuery.isPending) &&
    device !== undefined;
  return {
    loading,
    answered,
    sources,
    names,
    meta,
    settings,
    device,
    // Filtered and sorted; `ranked` is the ranking's own.
    view,
    ranked,
    pin,
    rows: listRows(view, open),
    toggleGroup,
    refresh,
    usual: (candidate: Candidate) => !!last && rememberedMatch(last, candidate) > 0,
    filtering,
    sourceFilter,
  };
}

// The addon chips as filters: which are chosen, and choosing one.
export type SourceFilter = {
  chosen: readonly string[];
  toggle: (source: string) => void;
};

// The watch party's way in (ADR-0051): the host's own link when they share
// it, and the stream of the user's that is the host's (the same torrent, or
// file), else any pick, which the party keeps in step.
function PartySources({
  party,
  match,
  onPick,
  onPlayShared,
}: {
  party: PartyInfo;
  match: Candidate | undefined;
  onPick: (candidate: Candidate) => void;
  onPlayShared: (shared: SharedStream) => void;
}) {
  const host = party.members?.find((member) => member.host);
  const shared = party.shared ?? undefined;
  return (
    <section
      aria-label="Watch party"
      className="mx-page flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl bg-sun/10 px-5 py-4"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Users aria-hidden className="mt-0.5 size-5 shrink-0 text-sun-ink" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-body font-[590]">
            {party.isHost
              ? "Your watch party is watching this"
              : `Watching with ${host?.name ?? "the"}${host ? "’s" : ""} party`}
          </p>
          <p className="text-small text-muted-foreground">
            {match
              ? "One of your streams is the host’s file, so you’ll see the same thing."
              : "Pick any stream: Peli keeps it in step with the party."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {shared && !party.isHost && (
          <Button variant="secondary" onClick={() => onPlayShared(shared)}>
            Play {shared.sharedBy}’s stream
          </Button>
        )}
        {match && !party.isHost && (
          <Button variant="sun" onClick={() => onPick(match)}>
            Play the party’s source
          </Button>
        )}
      </div>
    </section>
  );
}

// How many streams so far, and each addon's (and plugin's) answer, with Try
// again on one that failed.
export function StreamsSummary({
  sources,
  loading,
  total,
  shown = total,
  filter,
}: {
  sources: StreamSource[];
  loading: boolean;
  total: number;
  // How many the filters leave.
  shown?: number;
  // The chips choose addons, when the streams come from more than one.
  filter?: SourceFilter | undefined;
}) {
  const compact = useCompactShell();
  const waiting = sources.filter((source) => source.status === "pending").length;
  const failed = sources.filter((source) => source.status === "error");
  const plural = sources.some((source) => source.kind === "plugin") ? "sources" : "addons";
  const one = plural === "sources" ? "1 source" : "1 addon";
  return (
    <div className="flex flex-col gap-3">
      <p aria-live="polite" className="px-page text-body text-muted-foreground">
        {shown !== total && `${shown} of `}
        {total === 1 ? "1 stream" : `${total} streams`}
        {waiting > 0
          ? `, ${waiting} of ${sources.length} ${plural} still answering`
          : // An addon whose manifest is still loading may serve streams too,
            // and plugins wait for the title's TMDB id.
            loading
            ? `, still loading ${plural}`
            : ` from ${sources.length === 1 ? one : `${sources.length} ${plural}`}`}
      </p>
      {failed.length > 1 && (
        <div className="px-page">
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={() => failed.forEach((source) => source.retry())}
          >
            <RotateCw aria-hidden />
            Try all again
          </Button>
        </div>
      )}
      {/* One addon that answered is told by the line above, not a chip. */}
      {!(compact && sources.length === 1 && sources[0]?.status === "success") && (
        <ScrollRail>
          <ul
            aria-label={plural === "sources" ? "Addons and plugins" : "Addons"}
            className="flex shrink-0 gap-2"
          >
            {sources.map((source) => (
              <SourceStatus
                key={source.key}
                source={source}
                filter={filter && (source.streams?.length ?? 0) > 0 ? filter : undefined}
              />
            ))}
          </ul>
        </ScrollRail>
      )}
    </div>
  );
}

// P plays the top pick from anywhere on the picker (or the player's stream
// switcher), unless the user is typing.
export function usePlayKey(top: Candidate | null, play: (candidate: Candidate) => void) {
  const latest = useRef({ top, play });
  useLayoutEffect(() => {
    latest.current = { top, play };
  });
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "p" || event.defaultPrevented || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (typing(event.target)) return;
      const { top: best, play: start } = latest.current;
      if (!best) return;
      event.preventDefault();
      start(best);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

// An addon's answer. Once it has streams, and others do too, it's a toggle
// that keeps only its streams (with any other chosen).
function SourceStatus({
  source,
  filter,
}: {
  source: StreamSource;
  filter?: SourceFilter | undefined;
}) {
  const { name } = source;
  const count = source.streams?.length ?? 0;
  const chosen = filter?.chosen.includes(source.key) ?? false;
  const content = (
    <>
      {source.status === "pending" && <Spinner className="size-4 text-muted-foreground" />}
      {source.status === "success" && (
        <Check aria-hidden className={cn("size-4", chosen ? "text-current" : "text-sun-ink")} />
      )}
      {source.status === "error" && (
        <AlertCircle aria-hidden className="size-4 text-destructive-foreground" />
      )}
      <span className="font-medium">{name}</span>
      <span className={cn("pe-1.5", chosen ? "opacity-75" : "text-muted-foreground")}>
        {source.status === "pending"
          ? "Asking…"
          : source.status === "success"
            ? count === 1
              ? "1 stream"
              : `${count} streams`
            : source.error?.message}
      </span>
    </>
  );
  return (
    <li
      aria-label={name}
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 rounded-full border bg-card text-sm whitespace-nowrap",
        filter ? "p-0" : "ps-3 pe-1.5",
        chosen && "border-foreground bg-foreground text-background",
      )}
    >
      {filter ? (
        <button
          type="button"
          aria-pressed={chosen}
          title={chosen ? `Show every addon’s streams` : `Only ${name}’s streams`}
          onClick={() => filter.toggle(source.key)}
          className="flex h-full cursor-pointer items-center gap-2 rounded-full ps-3 pe-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {content}
        </button>
      ) : (
        content
      )}
      {source.status === "error" && (
        <Button size="sm" variant="ghost" className="rounded-full" onClick={source.retry}>
          Try again
        </Button>
      )}
    </li>
  );
}
