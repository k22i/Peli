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
import { AlertCircle, Check, ChevronLeft, Puzzle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Profile } from "@bindings/store";
import { Service as Sync } from "@bindings/syncer";
import { Notice } from "@/components/browse/browse-page";
import { listRows, StreamList } from "@/components/streams/stream-list";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { streamsQuery, type ContentType, type Stream } from "@/lib/addon-protocol";
import { chosenSourceQuery, remembered, rememberSource } from "@/lib/chosen-source";
import { useLoadedAddons } from "@/lib/home";
import { streamId, type PlayTarget, type StreamsSearch } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import { rememberedMatch, titleContext, type Candidate, type Tier } from "@/lib/ranking";
import { loadOptions, Player } from "@/lib/player";
import { attempts, PlayError, resolvePick } from "@/lib/resolve";
import { isPluginSource, pluginSource, pluginStreamsQuery } from "@/lib/plugins";
import { profileSettingsQuery } from "@/lib/settings";
import {
  rankingPrefs,
  usePluginSources,
  useRankedStreams,
  useStreamAddons,
  useStreams,
  type StreamSource,
} from "@/lib/streams";
import { resolutionLabel } from "@/lib/stream-labels";
import { subtitleTarget } from "@/lib/subtitles";
import { Torrents, torrentStatusText } from "@/lib/torrent";
import {
  cachedTitleMeta,
  isSeriesType,
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
    <div className="flex flex-col gap-6 py-6">
      <div className="flex items-center gap-3 px-gutter">
        <BackButton />
        <h1 className="font-heading text-title font-stretch-semi-expanded">{target.title}</h1>
      </div>
      {profile ? (
        <Picker
          key={`${type}/${video}`}
          profile={profile}
          type={type}
          video={video}
          target={target}
        />
      ) : (
        <Asking />
      )}
    </div>
  );
}

function BackButton() {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label="Back"
      onClick={() => (canGoBack ? router.history.back() : void navigate({ to: "/" }))}
      className="rounded-full"
    >
      <ChevronLeft className="size-5" />
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
  const { loading, sources, names, meta, settings, view, pin, rows, toggleGroup, refresh, usual } =
    useStreamChoices(profile.id, type, target.id, video, target.title);
  const client = useQueryClient();
  const navigate = useNavigate();
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
  const pick = (candidate: Candidate) => {
    pin();
    if (opening.current) {
      opening.current.controller.abort();
      toastManager.close(opening.current.toast);
    }
    const controller = new AbortController();
    const quality = resolutionLabel(candidate.parsed) ?? "the stream";
    const toast = toastManager.add({
      type: "loading",
      title: `Opening ${quality} from ${names.get(candidate.source) ?? "an addon"}…`,
      timeout: 0,
    });
    const current = { controller, toast };
    opening.current = current;
    // A torrent takes a while to find peers: say how it's going.
    let settled = false;
    const statusTimer = attempts(candidate).some(({ stream }) => !stream.url && stream.infoHash)
      ? setInterval(() => {
          Torrents.Status()
            .then((status) => {
              if (settled || !status.active) return;
              toastManager.update(toast, { description: torrentStatusText(status) });
            })
            .catch(() => {});
        }, 1000)
      : undefined;
    resolvePick(candidate, { refresh, signal: controller.signal })
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
          const start = progress ? resumePoint(progress, watching) : (target.resumeAt ?? 0) / 1000;
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
                state: (state) => ({
                  ...state,
                  player: {
                    ...playerHeading(meta, video, target.title),
                    source,
                    watching,
                    resumedAt: start,
                    stream: attempt.stream,
                    subtitles: subtitleTarget(
                      type,
                      video,
                      attempt.stream,
                      names.get(attempt.source) ?? "",
                    ),
                  },
                }),
              });
            },
            () => {
              toastManager.update(toast, {
                type: "error",
                title: `Can’t play ${target.title}`,
                description: "Sinag’s player couldn’t start. Try again, or restart Sinag.",
                timeout: 8000,
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
            ...(failed.kind === "torrent" && {
              actionProps: {
                children: "Open Settings",
                onClick: () => void navigate({ to: "/settings" }),
              },
            }),
          });
        },
      )
      .finally(() => {
        if (opening.current === current) opening.current = null;
      });
  };
  usePlayKey(view.top, pick);

  if (sources.length === 0) {
    if (loading) return <Asking />;
    // An AniList id: AniList knows the title, but the anime list has no
    // Kitsu id for it yet, and stream addons find anime by Kitsu or IMDb id
    // (#108).
    if (video.startsWith("anilist:")) {
      return (
        <div className="pt-12">
          <Notice
            icon={Puzzle}
            title="No streams yet"
            description="Stream addons find anime by its Kitsu or IMDb id, and this one doesn’t have either yet. New titles usually get one within a few days."
          />
        </div>
      );
    }
    return (
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
    );
  }

  return (
    <>
      <StreamsSummary sources={sources} loading={loading} total={view.total} />
      <StreamList
        rows={rows}
        names={names}
        onNavigate={pin}
        onPick={pick}
        onToggleGroup={toggleGroup}
        usual={usual}
      />
    </>
  );
}

// The ranked streams for one film or episode, as the picker and the
// player's stream switcher (#68) list them: every stream addon asked, and
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
  const meta = useQuery({
    ...titleMetaQuery(browsing.addons, type, id),
    enabled: !browsing.loading,
    ...cachedTitleMeta(client, browsing.addons, type, id),
  }).data?.meta;
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
  const chosen = useQuery({
    ...chosenSourceQuery(profileId, id),
    enabled: isSeriesType(type),
  }).data;
  const last = isSeriesType(type) ? remembered(chosen) : null;
  const ctx = titleContext(type, video, meta, title);
  const { view, pin } = useRankedStreams(sources, ctx, rankingPrefs(settings, last));
  const [open, setOpen] = useState<ReadonlySet<Tier>>(new Set());
  const toggleGroup = (tier: Tier) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(tier)) next.add(tier);
      return next;
    });
  return {
    loading,
    sources,
    names,
    meta,
    settings,
    view,
    pin,
    rows: listRows(view, open),
    toggleGroup,
    refresh,
    usual: (candidate: Candidate) => !!last && rememberedMatch(last, candidate) > 0,
  };
}

// How many streams so far, and each addon's (and plugin's) answer, with Try
// again on one that failed.
export function StreamsSummary({
  sources,
  loading,
  total,
}: {
  sources: StreamSource[];
  loading: boolean;
  total: number;
}) {
  const waiting = sources.filter((source) => source.status === "pending").length;
  const plural = sources.some((source) => source.kind === "plugin") ? "sources" : "addons";
  const one = plural === "sources" ? "1 source" : "1 addon";
  return (
    <div className="flex flex-col gap-3 px-gutter">
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {total === 1 ? "1 stream" : `${total} streams`}
        {waiting > 0
          ? `, ${waiting} of ${sources.length} ${plural} still answering`
          : // An addon whose manifest is still loading may serve streams too,
            // and plugins wait for the title's TMDB id.
            loading
            ? `, still loading ${plural}`
            : ` from ${sources.length === 1 ? one : `${sources.length} ${plural}`}`}
      </p>
      <ul
        aria-label={plural === "sources" ? "Addons and plugins" : "Addons"}
        className="flex flex-wrap gap-2"
      >
        {sources.map((source) => (
          <SourceStatus key={source.key} source={source} />
        ))}
      </ul>
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

function SourceStatus({ source }: { source: StreamSource }) {
  const { name } = source;
  const count = source.streams?.length ?? 0;
  return (
    <li
      aria-label={name}
      className="flex h-9 items-center gap-2 rounded-full border bg-card ps-3 pe-1.5 text-sm"
    >
      {source.status === "pending" && <Spinner className="size-4 text-muted-foreground" />}
      {source.status === "success" && <Check aria-hidden className="size-4 text-brand" />}
      {source.status === "error" && (
        <AlertCircle aria-hidden className="size-4 text-destructive-foreground" />
      )}
      <span className="font-medium">{name}</span>
      <span className="pe-1.5 text-muted-foreground">
        {source.status === "pending"
          ? "Asking…"
          : source.status === "success"
            ? count === 1
              ? "1 stream"
              : `${count} streams`
            : source.error?.message}
      </span>
      {source.status === "error" && (
        <Button size="sm" variant="ghost" className="rounded-full" onClick={source.retry}>
          Try again
        </Button>
      )}
    </li>
  );
}
