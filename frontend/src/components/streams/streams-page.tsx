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
import { streamsQuery, type ContentType } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { streamId, type PlayTarget, type StreamsSearch } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import { titleContext, type Candidate, type Tier } from "@/lib/ranking";
import { loadOptions, Player } from "@/lib/player";
import { attempts, PlayError, resolvePick } from "@/lib/resolve";
import { profileSettingsQuery } from "@/lib/settings";
import {
  rankingPrefs,
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
// synced (#64).
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
  const { addons, loading } = useStreamAddons(profile.id);
  const sources = useStreams(addons, type, video);
  const names = new Map(addons.map((addon) => [addon.url, addon.manifest.name]));

  // What ranking knows: the title's details, as its page asked for them
  // (usually cached by now), and the profile's audio language. It starts
  // without them and starts again once they come.
  const client = useQueryClient();
  const browsing = useLoadedAddons(profile.id);
  const details = useQuery({
    ...titleMetaQuery(browsing.addons, type, target.id),
    enabled: !browsing.loading,
    ...cachedTitleMeta(client, browsing.addons, type, target.id),
  });
  const settings = useQuery(profileSettingsQuery(profile.id));
  const ctx = titleContext(type, video, details.data?.meta, target.title);
  const prefs = rankingPrefs(settings.data);
  const { view, pin } = useRankedStreams(sources, ctx, prefs);
  const [open, setOpen] = useState<ReadonlySet<Tier>>(new Set());
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
    resolvePick(candidate, {
      refresh: async (source) =>
        (await client.fetchQuery({ ...streamsQuery(source, type, video), staleTime: 0 })).streams,
      signal: controller.signal,
    })
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
          const watching = watchingFor(profile.id, target, details.data?.meta, progress ?? []);
          const start = progress ? resumePoint(progress, watching) : (target.resumeAt ?? 0) / 1000;
          // The player (#60) takes it from here, in the profile's languages
          // (#62), keeping its progress as it plays (#64).
          void Player.Load(source, loadOptions(start, settings.data, [], watching)).then(
            () => {
              toastManager.close(toast);
              void navigate({
                to: "/player",
                state: (state) => ({
                  ...state,
                  player: {
                    ...playerHeading(details.data?.meta, video, target.title),
                    source,
                    watching,
                    resumedAt: start,
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

  const waiting = sources.filter((source) => source.status === "pending").length;
  return (
    <>
      <div className="flex flex-col gap-3 px-gutter">
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {view.total === 1 ? "1 stream" : `${view.total} streams`}
          {waiting > 0
            ? `, ${waiting} of ${sources.length} addons still answering`
            : // An addon whose manifest is still loading may serve streams too.
              loading
              ? ", still loading addons"
              : ` from ${sources.length === 1 ? "1 addon" : `${sources.length} addons`}`}
        </p>
        <ul aria-label="Addons" className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <SourceStatus key={source.addon.url} source={source} />
          ))}
        </ul>
      </div>
      <StreamList
        rows={listRows(view, open)}
        names={names}
        onNavigate={pin}
        onPick={pick}
        onToggleGroup={(tier) =>
          setOpen((current) => {
            const next = new Set(current);
            if (!next.delete(tier)) next.add(tier);
            return next;
          })
        }
      />
    </>
  );
}

// P plays the top pick from anywhere on the picker, unless the user is
// typing.
function usePlayKey(top: Candidate | null, play: (candidate: Candidate) => void) {
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
  const { name } = source.addon.manifest;
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
