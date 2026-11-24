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
  List as ListIcon,
  Puzzle,
  RotateCw,
  Users,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { Profile } from "@bindings/store";
import { Service as Sync } from "@bindings/syncer";
import { glassButton, pillButton } from "@/components/account/focus-screen";
import { Notice } from "@/components/browse/browse-page";
import { Ambient } from "@/components/media/ambient";
import { Artwork } from "@/components/media/artwork";
import { useArtUnderBar } from "@/components/shell/bar-tone";
import { ScrollRail } from "@/components/media/scroll-rail";
import { StreamList } from "@/components/streams/stream-list";
import { useStreamChoices, type SourceFilter } from "@/components/streams/stream-choices";
import { filteredListProps } from "@/components/streams/stream-toolbar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { feature } from "@/lib/features";
import { isIOS } from "@/lib/platform";
import { useCompactShell } from "@/lib/shell-mode";
import { toastManager } from "@/components/ui/toast";
import type { ContentType } from "@/lib/addon-protocol";
import { rememberSource } from "@/lib/chosen-source";
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
import { profileSettingsQuery } from "@/lib/settings";
import { runtimeMinutes, type Candidate } from "@/lib/ranking";
import { loadOptions, Player } from "@/lib/player";
import { Party, partyWatches, useParty } from "@/lib/party";
import { usePartyAutoPick, type PartyPick } from "@/lib/party-pick";
import { attempts, PlayError, resolvePick } from "@/lib/resolve";
import { usePreResolve, useSettled } from "@/lib/pre-resolve";
import { filtersKey } from "@/lib/stream-filters";
import type { StreamSource } from "@/lib/streams";
import { resolutionLabel } from "@/lib/stream-labels";
import { neighbours, neighbourTarget } from "@/lib/stream-episodes";
import { subtitleTarget } from "@/lib/subtitles";
import { tmdbRef, useTmdbArt } from "@/lib/tmdb";
import { Torrents, torrentStatusText } from "@/lib/torrent";
import {
  episodeCode,
  type Episode,
  playerHeading,
  resumePoint,
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
          // The profile autoplays the top pick; `choose` in the address is
          // how the user asked for the list instead (and how Back from the
          // player lands on it).
          choose={search.choose === true}
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
  eyebrow = "Choose a source",
}: {
  title: string;
  episode?: string | undefined;
  backdrop?: string | undefined;
  steps?: EpisodeStepsProps | undefined;
  // What the page is for, over the title (not on the phone).
  eyebrow?: string;
}) {
  useArtUnderBar(backdrop !== undefined);
  const compact = useCompactShell();
  // The phone (#136): no hero. Back is in the top bar, and a 56 pt strip of
  // blurred art under it holds "Streams" and what it is for.
  if (compact) {
    return (
      <header
        className={cn(
          "relative isolate overflow-x-clip [--fade:var(--background)]",
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
            {eyebrow}
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
  choose,
}: {
  profile: Profile;
  type: ContentType;
  video: string;
  target: PlayTarget;
  // The list was asked for: the profile's autoplay stands down.
  choose: boolean;
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
  // Until the profile's settings say whether it autoplays, nothing is shown
  // that the autoplay would hide: the list mustn't flash first.
  const settingsPending = useQuery(profileSettingsQuery(profile.id)).isPending;
  // `choose` as the picker was opened: the autoplay puts it in the address
  // itself as it starts, and that mustn't stop it.
  const [chooseAtOpen] = useState(choose);
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
  const navigate = useNavigate();
  // The watch party, when it watches this (ADR-0051). Its host keeps the
  // picker, the party card and everyone else in step. A guest never chooses a
  // stream: Peli picks one from the host's, so there's no list to show.
  const partyState = useParty();
  const forParty = partyWatches(partyState?.party, type, target.id, video)
    ? (partyState?.party ?? undefined)
    : undefined;
  const guest = forParty !== undefined && !forParty.isHost;
  // What the guest's page says instead of a list. Called for a host too, so
  // every hook keeps its place; for a host it does nothing at all.
  const guestPick = usePartyAutoPick({
    profileId: profile.id,
    type,
    id: target.id,
    video,
    title: target.title,
    party: forParty ?? null,
    enabled: true,
  });
  const ahead = usePreResolve(settledTop, {
    // Never ahead for a guest: an auto-pick is the party's, not the guest's
    // own habit, and it never pre-resolves.
    enabled:
      device?.preResolve === true &&
      !profile.kids &&
      !guest &&
      !downloaded.isPending &&
      !downloaded.data,
    answered,
    refresh,
  });
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
  const headerWith = (eyebrow?: string) => (
    <PageHeader
      title={target.title}
      episode={playerHeading(meta, video, target.title).episode}
      backdrop={backdrop}
      steps={{ previous: near.previous, next: near.next, go: goTo }}
      {...(eyebrow && { eyebrow })}
    />
  );
  const header = headerWith();
  // Where it was left may have moved on another device: pull while the
  // user picks (Go skips it if it pulled in the last half minute).
  useEffect(() => {
    Sync.Pull().catch(() => {});
  }, []);

  // Resolving the pick (#53): one at a time, so a second pick replaces the
  // first, and none once the picker is left.
  const opening = useRef<{ cancel: () => void }>(null);
  useEffect(() => () => opening.current?.cancel(), []);
  const openSettings = () => void navigate({ to: "/settings", search: { section: "streaming" } });
  // A pick the user made says how it's going in a toast, with Cancel.
  const toastReport = (title: string, cancel: () => void): OpeningReport => {
    const toast = toastManager.add({
      type: "loading",
      title,
      timeout: 0,
      actionProps: { children: "Cancel", onClick: cancel },
    });
    return {
      status: (description) => toastManager.update(toast, { description }),
      failed: (notice) =>
        toastManager.update(toast, {
          type: "error",
          title: notice.title,
          description: notice.description,
          timeout: 8000,
          // Cancel goes; Open Settings stays for a torrent.
          actionProps: notice.settings
            ? { children: "Open Settings", onClick: openSettings }
            : undefined,
        }),
      close: () => toastManager.close(toast),
    };
  };
  const cantStart: PickNotice = {
    title: `Can’t play ${target.title}`,
    description: "Peli’s player couldn’t start. Try again, or restart Peli.",
  };
  // A finished download of this video plays as it is, whatever was picked:
  // no resolve, no network (ADR-0064).
  const playDownloaded = async (playable: Playable, report?: OpeningReport) => {
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
        // iOS, or an autoplay (the user never saw the list): the player
        // takes the picker's place, so Back and close land on the title.
        replace: isIOS() || report !== undefined,
        state: (state) => ({ ...state, player }),
      });
      return "played";
    } catch {
      if (report) report.failed(cantStart);
      else toastManager.add({ type: "error", ...cantStart, timeout: 8000 });
      return "failed";
    }
  };
  // Plays a stream: the user's pick, or the autoplay's, which says how it's
  // going on its own screen (`report`) rather than in a toast.
  const pick = async (candidate: Candidate, report?: OpeningReport): Promise<PickOutcome> => {
    pin();
    const playable = await client.fetchQuery(playableQuery(profile.id, video)).catch(() => null);
    return playable ? playDownloaded(playable, report) : pickStream(candidate, report);
  };
  const pickStream = async (candidate: Candidate, report?: OpeningReport): Promise<PickOutcome> => {
    opening.current?.cancel();
    const controller = new AbortController();
    const quality = resolutionLabel(candidate.parsed) ?? "the stream";
    // Cancel stops the resolve and leaves the picker as it was.
    const cancel = () => {
      controller.abort();
      out.close();
      if (opening.current === current) opening.current = null;
    };
    const out =
      report ??
      toastReport(`Opening ${quality} from ${names.get(candidate.source) ?? "an addon"}…`, cancel);
    const current = { cancel };
    opening.current = current;
    // A torrent takes a while to find peers: say how it's going.
    let settled = false;
    const statusTimer =
      feature("torrent") && attempts(candidate).some(({ stream }) => !stream.url && stream.infoHash)
        ? setInterval(() => {
            Torrents.Status()
              .then((status) => {
                if (settled || !status.active) return;
                out.status(torrentStatusText(status));
              })
              .catch(() => {});
          }, 1000)
        : undefined;
    try {
      // The top pick may have resolved already (#101); if that failed, it
      // resolves now, with its copies.
      const resolveNow = () => resolvePick(candidate, { refresh, signal: controller.signal });
      const early = ahead.take(candidate);
      let resolved;
      try {
        resolved = await (early
          ? early.catch(() => {
              controller.signal.throwIfAborted();
              return resolveNow();
            })
          : resolveNow());
      } catch (error) {
        if (controller.signal.aborted) return "cancelled";
        const failed =
          error instanceof PlayError
            ? error
            : new PlayError("unreachable", candidate.parsed.debrid);
        out.failed({
          title: failed.message,
          description: failed.description,
          settings: failed.kind === "torrent",
        });
        return "failed";
      } finally {
        settled = true;
        clearInterval(statusTimer);
      }
      const { source, attempt } = resolved;
      if (controller.signal.aborted) return "cancelled";
      // Where it was left, as the store has it now (#64); if the store
      // can't say, where the card said (resumeAt is in ms).
      const progress = await client
        .fetchQuery({ ...titleProgressQuery(profile.id, target.id), staleTime: 0 })
        .catch(() => undefined);
      if (controller.signal.aborted) return "cancelled";
      const watching = watchingFor(profile.id, target, meta, progress ?? []);
      const partyAt = forParty ? await Party.StartAt(forParty.media).catch(() => -1) : -1;
      if (controller.signal.aborted) return "cancelled";
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
      try {
        await Player.Load(source, loadOptions(start, settings, [], watching));
      } catch {
        out.failed(cantStart);
        return "failed";
      }
      out.close();
      // What played is the show's source now (#58), the top pick or not:
      // the next episode starts from it.
      rememberSource(client, profile.id, type, target.id, candidate, attempt);
      void navigate({
        to: "/player",
        // iOS, or an autoplay (the user never saw the list): the player
        // takes the picker's place, so Back and close land on the title.
        replace: isIOS() || report !== undefined,
        state: (state) => ({
          ...state,
          player: playerState({
            heading: playerHeading(meta, video, target.title),
            source,
            watching,
            start,
            stream: attempt.stream,
            subtitles: subtitleTarget(type, video, attempt.stream, names.get(attempt.source) ?? ""),
          }),
        }),
      });
      return "played";
    } finally {
      if (opening.current === current) opening.current = null;
    }
  };
  const pickFromList = (candidate: Candidate) => void pick(candidate);

  // Autoplay (profile setting): once every source has answered, the top
  // pick plays by itself, once per visit, and the list is never shown on
  // the way: a status screen is, with "Choose myself" for the list. Not for
  // a guest (the party picks), nor when the address asks for the list.
  const autoplay = useAutoplay({
    enabled: settings?.autoplayTopPick === true && !chooseAtOpen && !guest,
    answered,
    top: view.top,
    names,
    play: pick,
    cancelOpening: () => opening.current?.cancel(),
  });

  // P plays the top pick. A guest has nothing of their own to play, and
  // while the autoplay is at it there's nothing to press it over, so the key
  // does nothing then: the hook still runs, so every hook keeps its place.
  usePlayKey(guest || autoplay.screen ? null : view.top, pickFromList);

  // The guest's page, in every state: no list, no filters, no jump strip, and
  // no addons notice either — the status says when nothing opened.
  if (guest) return <GuestPick header={header} pick={guestPick} />;

  // Not known yet whether the profile autoplays: nothing it would hide.
  if (settingsPending && !chooseAtOpen) {
    return (
      <>
        {header}
        <Asking />
      </>
    );
  }

  // The profile autoplays: what it's doing, in place of the list.
  if (autoplay.screen && (sources.length > 0 || loading)) {
    return (
      <AutoplayPick
        header={headerWith("Playing the top pick")}
        status={autoplay.screen}
        detail={
          autoplay.screen.kind === "finding"
            ? findingText(sources, loading, ranked.total)
            : autoplay.screen.detail
        }
        chooseMyself={autoplay.chooseMyself}
      />
    );
  }

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
      {forParty && <PartySources />}
      <StreamsSummary
        sources={sources}
        loading={loading}
        total={ranked.total}
        shown={view.total}
        filter={sourceFilter}
      />
      {/* The autoplay found nothing to play, or it wouldn't open: the list,
          and why it's here. */}
      {autoplay.notice && <AutoplayNotice notice={autoplay.notice} openSettings={openSettings} />}
      <StreamList
        rows={rows}
        runtime={runtimeMinutes(meta?.runtime) ?? null}
        names={names}
        onNavigate={pin}
        onPick={pickFromList}
        onToggleGroup={toggleGroup}
        usual={usual}
        {...filteredListProps(filtering, view)}
      />
    </>
  );
}

// How long the filters stay put before the filtered top pick resolves ahead.
const filtersSettle = 1200;

// The watch party's card, for the host (ADR-0051): the party is watching what
// they pick, so whatever they pick is what everyone sees. A guest has no card
// of buttons here: they don't pick at all, and the guest's page says what
// Peli is doing for them instead.
function PartySources() {
  return (
    <section
      aria-label="Watch party"
      className="mx-page flex items-center gap-3 rounded-2xl bg-sun/10 px-5 py-4"
    >
      <Users aria-hidden className="mt-0.5 size-5 shrink-0 text-sun-ink" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-body font-[590]">Your watch party is watching this</p>
        <p className="text-small text-muted-foreground">
          Pick any stream: Peli keeps it in step with the party.
        </p>
      </div>
    </section>
  );
}

// The guest's picker (ADR-0051): Peli picks a stream from the host's, so there
// is nothing to choose — only what it's doing, in the FocusScreen's look
// (Ambient and the centred column), sized to what the page's header leaves
// rather than to the whole window.
function GuestPick({ header, pick }: { header: ReactNode; pick: PartyPick }) {
  const back = useLeave();
  const failed = pick.status === "failed";
  // What Peli is doing: finding the host's stream, opening it, or neither
  // worked, which is the one state with buttons.
  const heading = failed
    ? `Couldn’t open a stream like ${pick.hostName}’s`
    : pick.status === "searching"
      ? `Finding ${pick.hostName}’s stream…`
      : "Opening…";
  const detail = failed
    ? "None of your addons opened the party’s stream. Try again, or leave the party and pick one of your own."
    : "Peli plays the party’s stream, so you see exactly what they do.";
  return (
    <PickScreen header={header} slot="party-pick" label="Watch party">
      <div aria-live="polite" className="flex flex-col items-center gap-3">
        {failed ? (
          <AlertCircle aria-hidden className="size-9 text-sun" />
        ) : (
          <Users aria-hidden className="size-9 text-sun" />
        )}
        <h2 className="font-display text-[2rem] leading-tight text-balance">{heading}</h2>
        <p className="max-w-sm text-[0.9375rem] text-pretty text-muted-foreground">{detail}</p>
      </div>
      {failed && (
        <div className="flex w-full flex-col gap-3">
          <Button
            size="lg"
            variant="sun"
            className={cn(pillButton, "pointer-coarse:min-h-11")}
            onClick={pick.retry}
          >
            <RotateCw />
            Try again
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className={cn(pillButton, glassButton, "pointer-coarse:min-h-11")}
            onClick={back}
          >
            <ChevronLeft />
            Back
          </Button>
        </div>
      )}
    </PickScreen>
  );
}

// Back as the page's own Back: where the user came from, or Home.
function useLeave() {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return () => (canGoBack ? router.history.back() : void navigate({ to: "/" }));
}

// A status in place of the list, in the FocusScreen's look (Ambient and the
// centred column), sized to what the page's header leaves rather than to the
// whole window. The page's own bottom padding comes off the height, so the
// status fills the window and the page doesn't scroll for it. The header is
// the page's, not the status's: `slot` names the status alone, so a caller
// can find the status without the header's Back.
function PickScreen({
  header,
  slot,
  label,
  children,
}: {
  header: ReactNode;
  slot: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="relative isolate flex min-h-[calc(100dvh-var(--spacing-bar)-4rem)] flex-col">
      {/* Fixed: the sunrise sits on the window's bottom edge, not on the
          column's, which stops short of it by the page's bottom padding
          (and the tab bar's, on the phone). */}
      <Ambient tone="sun" className="fixed inset-0" />
      {header}
      <section
        data-slot={slot}
        aria-label={label}
        className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-8 px-6 py-12 text-center"
      >
        {children}
      </section>
    </div>
  );
}

// The autoplay's page: finding the top pick, then opening it. The list is
// one press away ("Choose myself" while it looks, Cancel while it opens),
// and the header's Back leaves.
function AutoplayPick({
  header,
  status,
  detail,
  chooseMyself,
}: {
  header: ReactNode;
  status: AutoplayScreen;
  detail: string | undefined;
  chooseMyself: () => void;
}) {
  const heading = status.kind === "finding" ? "Finding the best stream…" : status.title;
  return (
    <PickScreen header={header} slot="autoplay" label="Autoplay">
      <div className="flex flex-col items-center gap-3">
        <Spinner aria-hidden className="size-9 text-sun" />
        <output className="flex flex-col items-center gap-3">
          <span className="font-display text-[2rem] leading-tight text-balance">{heading}</span>
          <span className="max-w-sm text-[0.9375rem] text-pretty text-muted-foreground">
            {detail ?? "Peli plays the top pick for you."}
          </span>
        </output>
      </div>
      <Button
        size="lg"
        variant="ghost"
        className={cn(pillButton, glassButton, "w-full pointer-coarse:min-h-11")}
        onClick={chooseMyself}
      >
        {status.kind === "finding" ? (
          <>
            <ListIcon />
            Choose myself
          </>
        ) : (
          "Cancel"
        )}
      </Button>
    </PickScreen>
  );
}

// What the autoplay has heard so far, under "Finding the best stream…".
function findingText(sources: StreamSource[], loading: boolean, total: number) {
  const waiting = sources.filter((source) => source.status === "pending").length;
  const plural = sources.some((source) => source.kind === "plugin") ? "sources" : "addons";
  const streams = total === 1 ? "1 stream" : `${total} streams`;
  if (waiting > 0)
    return `${streams} so far, ${waiting} of ${sources.length} ${plural} still answering`;
  if (loading || sources.length === 0) return `Asking your ${plural}…`;
  return `${streams} in, choosing the best`;
}

// Why the list is showing after all: the autoplay found nothing to play, or
// what it picked wouldn't open.
function AutoplayNotice({
  notice,
  openSettings,
}: {
  notice: PickNotice;
  openSettings: () => void;
}) {
  return (
    <div className="mx-page flex items-start gap-3 rounded-2xl bg-sun/10 px-5 py-4">
      <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-sun-ink" />
      <output className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-[590]">{notice.title}</span>
        <span className="text-small text-muted-foreground">{notice.description}</span>
      </output>
      {notice.settings && (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 rounded-full"
          onClick={openSettings}
        >
          Open Settings
        </Button>
      )}
    </div>
  );
}

// What a pick came to: the player opened, it failed (and said why), or it
// was cancelled (or the picker was left).
type PickOutcome = "played" | "failed" | "cancelled";

// What a failed pick says: a toast's title and description, or the notice
// above the list after an autoplay. `settings` offers Open Settings (a
// torrent that wouldn't open).
type PickNotice = { title: string; description: string; settings?: boolean };

// Where a pick that's opening says how it's going.
type OpeningReport = {
  // A torrent's peers, as they come.
  status: (description: string) => void;
  failed: (notice: PickNotice) => void;
  // It opened, or was cancelled.
  close: () => void;
};

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

// The autoplay's screen: still waiting on the sources, or opening the top
// pick (with a torrent's peers as they come).
type AutoplayScreen =
  | { kind: "finding" }
  | { kind: "opening"; candidate: Candidate; title: string; detail?: string };

const nothingToPlay: PickNotice = {
  title: "Nothing to play by itself",
  description: "Peli couldn’t find a stream to start for you. Here’s what your addons sent.",
};

// What the autoplay is at. `list` is where it ends unless the player opens:
// the user chose, cancelled, or there was nothing to play (`notice` says).
type AutoplayStatus = AutoplayScreen | { kind: "list"; notice?: PickNotice };

// Autoplay (profile setting): once every source has answered, the top
// pick plays by itself, once per visit, and the list stays hidden until it
// either opens (the player takes over) or doesn't (the list, with a
// notice). The address gets `choose` as it starts (replace), so Back from
// the player shows the list instead of autoplaying again.
function useAutoplay({
  enabled,
  answered,
  top,
  names,
  play,
  cancelOpening,
}: {
  enabled: boolean;
  answered: boolean;
  top: Candidate | null;
  names: ReadonlyMap<string, string>;
  play: (candidate: Candidate, report: OpeningReport) => Promise<PickOutcome>;
  // Stops the pick that's opening, if any.
  cancelOpening: () => void;
}) {
  const navigate = useNavigate();
  // The latest of each, as `usePlayKey` keeps its own: the effect fires
  // once, so it must play what pick is now, not what it was then.
  const latest = useRef({ play, navigate });
  useLayoutEffect(() => {
    latest.current = { play, navigate };
  });
  const [status, setStatus] = useState<AutoplayStatus>({ kind: "finding" });
  // Every source has answered and the ranking has caught up: the top pick
  // opens, or with none there's nothing to play. Set while rendering, so
  // the screen never gives way to the list for a frame on the way.
  if (enabled && answered && status.kind === "finding") {
    if (top) {
      const quality = resolutionLabel(top.parsed) ?? "the top pick";
      setStatus({
        kind: "opening",
        candidate: top,
        title: `Opening ${quality} from ${names.get(top.source) ?? "an addon"}…`,
      });
    } else {
      setStatus({ kind: "list", notice: nothingToPlay });
    }
  }
  // The pick to open, once.
  const opening = status.kind === "opening" ? status.candidate : null;
  const started = useRef<Candidate>(null);
  useEffect(() => {
    if (!opening || started.current) return;
    started.current = opening;
    const { play: start, navigate: go } = latest.current;
    // The list stays reachable, and doesn't autoplay again on the way back.
    void go({
      to: ".",
      search: (previous: StreamsSearch): StreamsSearch => ({ ...previous, choose: true }),
      replace: true,
    });
    void start(opening, {
      status: (detail) =>
        setStatus((current) => (current.kind === "opening" ? { ...current, detail } : current)),
      failed: (notice) => setStatus({ kind: "list", notice }),
      close: () => {},
    }).then((outcome) => {
      if (outcome === "cancelled")
        setStatus((current) => (current.kind === "list" ? current : { kind: "list" }));
    });
  }, [opening]);
  return {
    // What to show in place of the list, or null for the list.
    screen: enabled && status.kind !== "list" ? status : null,
    // Why the list is showing after all.
    notice: enabled && status.kind === "list" ? status.notice : undefined,
    // "Choose myself" and Cancel: the user is choosing, so the profile
    // stands down, and what it was opening stops.
    chooseMyself: () => {
      cancelOpening();
      setStatus({ kind: "list" });
    },
  };
}

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
