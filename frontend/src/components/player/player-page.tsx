import { Slider } from "@base-ui/react/slider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCanGoBack, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  History as Resumed,
  AlertCircle,
  AudioLines,
  Captions,
  ChevronLeft,
  Keyboard,
  ListVideo,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  SlidersHorizontal,
  Users,
  Volume1,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { PartyPill, PartySheet } from "@/components/party/party-sheet";
import { NextEpisode } from "@/components/player/next-episode";
import { PictureSheet, type PictureSheetTab } from "@/components/player/picture-sheet";
import { Prompt, promptEnter } from "@/components/player/prompt";
import { SeekBar } from "@/components/player/seek-bar";
import { SecondSubtitles } from "@/components/player/second-subtitles";
import { ShortcutsOverlay } from "@/components/player/shortcuts";
import { SpeedMenu } from "@/components/player/speed-menu";
import { StreamSwitcher, type Refresh } from "@/components/player/stream-switcher";
import {
  defaultSubtitleStyle,
  SubtitlePanel,
  type PanelTab,
  type SubtitleStyle,
} from "@/components/player/subtitle-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { streamsQuery } from "@/lib/addon-protocol";
import { rememberSource } from "@/lib/chosen-source";
import { useLoadedAddons } from "@/lib/home";
import {
  segmentAt,
  skipLabels,
  skipSegments,
  useOnlineSegments,
  type Segment,
} from "@/lib/markers";
import { countdownFrom, nextEpisode, type PreparedNext } from "@/lib/next-episode";
import {
  mediaLabel,
  noticeText,
  Party,
  partyMedia,
  sharedStream,
  useParty,
  usePartyChat,
  usePartyNotices,
  useWatchWithParty,
} from "@/lib/party";
import { streamsPath, streamsSearch } from "@/lib/playback";
import {
  liftNow,
  liftStep,
  liftText,
  liftToClear,
  nudgeLift,
  nudgeSize,
  sizeStep,
  useWindowHeight,
} from "@/lib/subtitle-position";
import { repaintWindow } from "@/lib/theme";
import {
  formatTime,
  latestOnly,
  loadOptions,
  maxSubtitleDelay,
  nextTrackId,
  Player,
  reloadExpired,
  subtitleDelayText,
  trackLabel,
  useAhead,
  useIdle,
  usePlayerEnded,
  usePlayerState,
  type Ended,
  type Track,
} from "@/lib/player";
import { useCurrentProfile } from "@/lib/profile";
import type { Candidate } from "@/lib/ranking";
import { attempts, PlayError, resolvePick, sameStream } from "@/lib/resolve";
import {
  deviceSettingsQuery,
  profileSettingsQuery,
  useSaveDeviceSettings,
  useSaveProfileSettings,
  type ProfileSettings,
} from "@/lib/settings";
import {
  aspectName,
  aspectRatios,
  cycle,
  defaultFraming,
  fitModes,
  fitName,
  framingOf,
  panBy,
  unzoomed,
  zoomBy,
  zoomLabel,
  type Framing,
} from "@/lib/framing";
import { pictureOf, savePreset, standardPicture, userPreset, type Picture } from "@/lib/picture";
import { qualityOf, type Quality } from "@/lib/quality";
import { audioOf, clampVolume, soundOf, type Audio, type Sound } from "@/lib/sound";
import { normalSpeed, speedLabel, stepSpeed } from "@/lib/speed";
import { resolutionLabel } from "@/lib/stream-labels";
import {
  titleAdjustmentsQuery,
  useSaveTitleAdjustments,
  withSection,
} from "@/lib/title-adjustments";
import {
  autoSecondary,
  autoSubtitle,
  secondChoices,
  subtitleLanguage,
  subtitleTarget,
  useAddonSubtitles,
  type AddonSubtitle,
} from "@/lib/subtitles";
import { invalidateWatching } from "@/lib/sync";
import {
  cachedTitleMeta,
  episodeCode,
  episodeTarget,
  isSeriesType,
  playerHeading,
  resumePoint,
  titleMetaQuery,
  titleProgressQuery,
  watchingFor,
} from "@/lib/title";
import { isTorrentSource, Torrents, torrentStatusText, useTorrentStatus } from "@/lib/torrent";
import { cn } from "@/lib/utils";

// What a failed file says, by internal/player's end codes, and whether
// trying the same stream again can help.
const failures: Record<string, { title: string; description: string; retry: boolean }> = {
  expired: {
    title: "The link expired",
    description: "Try again for a new link from the addon, or choose another stream.",
    retry: true,
  },
  unsupported: {
    title: "Sinag can’t play this file",
    description: "Its format isn’t one Sinag’s player reads. Choose another stream.",
    retry: false,
  },
};
const failed = {
  title: "The stream stopped",
  description: "It couldn’t be loaded. Try again, or choose another stream.",
  retry: true,
};

// How long the pointer and keys stay still before the controls and the
// cursor hide, while playing.
const idleAfter = 3000;
// ±10 s.
const skip = 10;
// One press of Z or X moves subtitles this many seconds, as in mpv.
const delayStep = 0.1;
// One press of ↑ or ↓ moves the volume this much, of 100.
const volumeStep = 5;
// How long "Start over" is offered once a resumed file plays.
const startOverFor = 10_000;
// How long the play/pause mark at the centre takes to fade out.
const flashFor = 450;
// How long the subtitles stay where a nudge put them, to show it, before
// they rise for the controls again.
const nudgeShown = 2500;

// The player screen: the video under a transparent page, with no app shell,
// and the controls over it (#61). They show on any move or key and hide
// after a few still seconds while playing, with the cursor. Everything the
// user does shows at once and catches up with mpv after (useAhead): round
// trips reach 100 ms and more on slow machines. A click or Space pauses, a
// double click goes fullscreen, Esc leaves fullscreen or the screen. A
// torrent (#55) shows its peers, speed and buffer at the top, and under the
// spinner while it waits for pieces. The Audio and Subtitles menus (#62)
// switch tracks, size subtitles (saved as the profile's size) and time them,
// as do Z (earlier) and X (later). Subtitles from addons (#63) are listed by
// language under the file's own; one in the profile's language is added by
// itself when captions are on and the file has none in it. The language of
// subtitles picked here becomes the profile's. Go keeps the profile's
// progress as it plays (#64); a file that resumed offers "Start over" for its
// first few seconds, and leaving refreshes Continue Watching and the marks.
// Once an episode counts as watched, a card offers the next (#65), which
// plays in the same session at the end, as a new file of the screen. The
// keys (#67) are in shortcuts.tsx, listed by ? over the video; the OS's
// media controls (Go, media.go) name what plays from the heading. Streams
// (or S) lists the film's or episode's other streams, ranked, and plays the
// one picked from where this one is, as a new file of the screen (#68).
// Where the file's chapters or IntroDB say an intro, recap or credits are
// (#69), a button skips them; intros and recaps skip by themselves when the
// profile says so, once each. With a next episode, the card stands in for
// Skip credits, and waits for them when they start after the watched mark.
// Mini player (or I) makes the window small and keeps it above other
// windows (#70; Go's SetMini): the controls shrink to play, mute and the
// seek bar, and a double click or Esc makes it the app window again.
export function PlayerPage() {
  const queryClient = useQueryClient();
  const playing = useLocation({ select: (location) => location.state.player });
  // The source playing now: the next episode replaces it in history state.
  // Leaving renders this once more with the next screen's state, without it.
  const playingSource = useRef(playing?.source);
  useEffect(() => {
    if (playing?.source) playingSource.current = playing.source;
  });
  // Leaving the screen, however it happens, ends the session, and lets the
  // torrent go once mpv no longer reads it. Go has kept where it stopped by
  // the time Stop returns, so the screens behind show it.
  useEffect(
    () => () => {
      const streamed = isTorrentSource(playingSource.current);
      // A watch party (ADR-0051) sees this member stop watching; the next
      // episode or another stream, as a new file of the screen, doesn't.
      Party.Watch(null, null).catch(() => {});
      Player.Stop()
        .catch(() => {})
        .finally(() => {
          repaintWindow();
          invalidateWatching(queryClient);
          if (streamed) Torrents.Release().catch(() => {});
        });
    },
    [queryClient],
  );
  // One file at a time: the next episode starts afresh.
  return <PlayerFile key={playing?.source?.url ?? ""} />;
}

function PlayerFile() {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const playing = useLocation({ select: (location) => location.state.player });
  const watching = playing?.watching;
  const queryClient = useQueryClient();
  const state = usePlayerState();
  const [error, setError] = useState<Ended>();
  const [retrying, setRetrying] = useState(false);
  // The source now playing, when its link was last asked for again, and
  // where a failed file stopped.
  const source = useRef(playing?.source);
  const reloadedAt = useRef(0);
  const stoppedAt = useRef(0);
  const torrent = isTorrentSource(playing?.source);
  const torrentStatus = useTorrentStatus(torrent);
  const profileId = useCurrentProfile().id ?? 0;
  const settings = useQuery({ ...profileSettingsQuery(profileId), enabled: profileId > 0 }).data;
  const saveSettings = useSaveProfileSettings(profileId);
  // The tracks last playing: mpv empties the list when a file fails, and
  // trying it again should keep what the user picked.
  const lastTracks = useRef<Track[]>([]);
  useEffect(() => {
    if (state.tracks?.length) lastTracks.current = state.tracks;
  }, [state.tracks]);
  const tracks = state.tracks ?? [];
  const target = useLocation({ select: (location) => location.state.player?.subtitles });
  const addonSubtitles = useAddonSubtitles(profileId, target);
  const systemCaptions = useQuery({
    queryKey: ["player", "system-captions"],
    queryFn: () => Player.SystemCaptions(),
  }).data;
  // Each time this screen loads the file again (a retry, a fresh link), mpv
  // drops the subtitles added to it: the addon ones added to this load, by
  // key, and the one showing, to add again to the next.
  const [added, setAdded] = useState<{ load: number; ids: ReadonlyMap<string, number> }>({
    load: 0,
    ids: new Map(),
  });
  const showingAddon = useRef<AddonSubtitle>(undefined);
  const autoDone = useRef(false);
  const readdedFor = useRef(0);
  const readdedSecondFor = useRef(0);
  // The second line (dual subtitles): what it showed, to show again after a
  // reload, and whether the profile's second language was tried for this file.
  const showingSecond = useRef<{ track: number } | { addon: AddonSubtitle }>(undefined);
  const autoSecondDone = useRef(false);

  const [paused, setPaused] = useAhead(state.paused, same);
  const [position, setPosition] = useAhead(state.position, near);
  const [volume, setVolume] = useAhead(state.volume, near);
  // 100, or 150 with this device's volume boost (Sound tab).
  const volumeMax = (state.volumeMax ?? 0) > 0 ? state.volumeMax : 100;
  const [muted, setMuted] = useAhead(state.muted, same);
  const [fullscreen, setFullscreen] = useAhead(state.fullscreen, same);
  const [mini, setMini] = useAhead(state.mini, same);
  const audioTracks = tracks.filter((track) => track.type === "audio");
  const subtitleTracks = tracks.filter((track) => track.type === "sub");
  const [audioId, setAudioId] = useAhead(selectedId(audioTracks), same);
  const [subtitleId, setSubtitleId] = useAhead(selectedId(subtitleTracks), same);
  const [secondaryId, setSecondaryId] = useAhead(
    subtitleTracks.find((track) => track.secondary)?.id ?? 0,
    same,
  );
  const [subtitleDelay, setSubtitleDelay] = useAhead(
    state.subtitleDelay,
    (a, b) => Math.abs(a - b) < 0.001,
  );
  const [speed, setSpeed] = useAhead(state.speed, (a, b) => Math.abs(a - b) < 0.001);
  // One seek and one volume change at a time, the newest next.
  const [seeker] = useState(() =>
    latestOnly(({ to, exact }: { to: number; exact: boolean }) =>
      exact ? Player.Seek(to) : Player.Scrub(to),
    ),
  );
  const [volumer] = useState(() => latestOnly(Player.SetVolume));
  const [delayer] = useState(() => latestOnly(Player.SetSubtitleDelay));
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  // The audio and subtitles panel, by tab, or closed.
  const [panel, setPanel] = useState<PanelTab>();
  const [pictureOpen, setPictureOpen] = useState(false);
  const menuOpen = panel !== undefined || pictureOpen;
  // The addon subtitles being added, to show a spinner on their row.
  const [loadingKey, setLoadingKey] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  // The dock's menus (Speed, More) have the keys while open.
  const [speedOpen, setSpeedOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // The stream being opened from the switcher, or why it couldn't be.
  const [switchStatus, setSwitchStatus] = useState<{ text: string; failed?: string }>();
  const pickAbort = useRef<AbortController>(null);
  useEffect(() => () => pickAbort.current?.abort(), []);
  const [idle, wake] = useIdle(idleAfter);
  // A click or key that pauses or plays, shown at the centre for a moment.
  const [flash, setFlash] = useState<{ id: number; paused: boolean }>();
  const flashes = useRef(0);
  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(undefined), flashFor);
    return () => clearTimeout(timer);
  }, [flash]);
  // What a key just changed, shown over the video for a moment.
  const [notice, setNotice] = useState<{ text: string }>();
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(undefined), 1500);
    return () => clearTimeout(timer);
  }, [notice]);

  // What the OS's media controls name: the heading.
  const heading = { title: playing?.title ?? "", subtitle: playing?.episode ?? "" };
  useEffect(() => {
    Player.SetNowPlaying({ title: heading.title, subtitle: heading.subtitle }).catch(() => {});
  }, [heading.title, heading.subtitle]);

  const reloaded = () => setAdded(({ load }) => ({ load: load + 1, ids: new Map() }));
  const leave = () => (canGoBack ? router.history.back() : void navigate({ to: "/" }));

  // The series' details, as its page asked for them, for the next episode.
  const browsing = useLoadedAddons(profileId);
  const series = watching && isSeriesType(watching.contentType) ? watching : undefined;
  const meta = useQuery({
    ...titleMetaQuery(browsing.addons, series?.contentType ?? "", series?.contentId ?? ""),
    enabled: series !== undefined && !browsing.loading,
    ...(series &&
      cachedTitleMeta(queryClient, browsing.addons, series.contentType, series.contentId)),
  }).data?.meta;
  const next = meta && series ? nextEpisode(meta, series.videoId) : undefined;
  const [cancelled, setCancelled] = useState(false);
  const onlineSegments = useOnlineSegments(watching);
  const segments = skipSegments(state.chapters ?? [], onlineSegments, state.duration);
  const from = countdownFrom(
    state.duration,
    segments.find((segment) => segment.kind === "credits")?.start,
  );
  const counting =
    next !== undefined && from !== undefined && state.position >= from && !cancelled && !error;
  // Play now, or the end: the card hands over what it found.
  const [starting, setStarting] = useState(false);

  // A watch party (ADR-0051): Go follows the player and keeps it in step;
  // this screen says what it plays (as the party names it), opens the party
  // sheet (W), shows the party's line at the top, and offers to follow the
  // party when it watches something else.
  const partyState = useParty();
  const party = partyState?.party ?? undefined;
  const partyChat = usePartyChat();
  const [partyOpen, setPartyOpen] = useState(false);
  const media = watching ? partyMedia(watching, heading, meta, playing?.stream) : undefined;
  const shared =
    playing?.source && !torrent ? sharedStream(playing.source, playing.stream) : undefined;
  const mediaKey = media
    ? [
        media.type,
        media.id,
        media.season,
        media.episode,
        media.source?.infoHash,
        media.source?.filename,
        media.poster,
      ].join("|")
    : "";
  useEffect(() => {
    if (media) Party.Watch(media, shared ?? null).catch(() => {});
    // oxlint-disable-next-line react/exhaustive-deps -- once per file and stream
  }, [mediaKey, shared?.url]);
  const [partyNotice, setPartyNotice] = useState<string>();
  useEffect(() => {
    if (!partyNotice) return undefined;
    const timer = setTimeout(() => setPartyNotice(undefined), 3000);
    return () => clearTimeout(timer);
  }, [partyNotice]);
  usePartyNotices((said) => {
    // The party moving on is the prompt's to offer.
    if (said.kind === "media") return;
    const text = noticeText(said);
    if (text) setPartyNotice(text);
  });
  const watchWithParty = useWatchWithParty();
  const partyElsewhere = party && !party.watching && media ? party.media : undefined;
  const partyIsNext =
    partyElsewhere !== undefined &&
    meta !== undefined &&
    next !== undefined &&
    partyElsewhere.id === meta.id &&
    partyElsewhere.videoId === next.id;
  // While the next episode opens, the file ending or failing is expected.
  const switching = useRef(false);
  const switchAbort = useRef<AbortController>(null);
  useEffect(() => () => switchAbort.current?.abort(), []);

  usePlayerEnded((ended) => {
    if (switching.current) return;
    if (ended.reason === "eof") {
      if (counting) return setStarting(true);
      return leave();
    }
    stoppedAt.current = state.position;
    // A link that expired mid-play is asked for again, at most once a
    // minute, and plays on from where it stopped. A torrent's loopback link
    // doesn't expire.
    const expired = source.current;
    if (
      ended.code === "expired" &&
      expired &&
      !isTorrentSource(expired) &&
      Date.now() - reloadedAt.current > 60_000
    ) {
      reloadedAt.current = Date.now();
      reloadExpired(
        expired,
        loadOptions(state.position, settings, lastTracks.current, watching),
      ).then(
        (fresh) => {
          source.current = fresh;
          reloaded();
        },
        () => setError(ended),
      );
      return;
    }
    setError(ended);
  });
  const retry = async (ended: Ended) => {
    const current = source.current;
    if (!current) return;
    setRetrying(true);
    try {
      const options = loadOptions(stoppedAt.current, settings, lastTracks.current, watching);
      if (ended.code === "expired" && !isTorrentSource(current))
        source.current = await reloadExpired(current, options);
      else await Player.Load(current, options);
      reloaded();
      setError(undefined);
    } catch {
      // Still failed: the overlay stays.
    } finally {
      setRetrying(false);
    }
  };

  const ready = state.active && !error;
  // A menu the dock no longer shows (the mini player, a failure) is closed.
  const dockMenuOpen = speedOpen && ready && !mini;
  const known = state.duration > 0;
  // The picker for the next episode, in place of this screen: no stream
  // was found or would open.
  const chooseNext = () => {
    if (!meta || !next) return leave();
    const nextTarget = episodeTarget(meta, next);
    void navigate({
      to: streamsPath,
      params: { type: nextTarget.type, id: nextTarget.id },
      search: streamsSearch({ video: nextTarget.videoId }),
      state: (current) => ({ ...current, play: nextTarget }),
      replace: true,
    });
  };
  // Plays the next episode in this session: its progress kept as its own,
  // from where it was left, in the languages playing now.
  const playNext = async (prepared: PreparedNext) => {
    if (!meta || !next || prepared.status !== "ready") return chooseNext();
    const controller = new AbortController();
    switchAbort.current = controller;
    switching.current = true;
    const nextTarget = episodeTarget(meta, next);
    try {
      const { source: nextSource, attempt } =
        prepared.resolved ??
        (await resolvePick(prepared.candidate, {
          refresh: async (addon) =>
            (
              await queryClient.fetchQuery({
                ...streamsQuery(addon, meta.type, next.id),
                staleTime: 0,
              })
            ).streams,
          signal: controller.signal,
        }));
      const progress = await queryClient
        .fetchQuery({ ...titleProgressQuery(profileId, meta.id), staleTime: 0 })
        .catch(() => undefined);
      controller.signal.throwIfAborted();
      const nextWatching = watchingFor(profileId, nextTarget, meta, progress ?? []);
      const start = progress ? resumePoint(progress, nextWatching) : 0;
      await Player.Load(nextSource, loadOptions(start, settings, lastTracks.current, nextWatching));
      // The show's source (#58), as it played this time.
      rememberSource(queryClient, profileId, meta.type, meta.id, prepared.candidate, attempt);
      // A torrent playing that the next episode doesn't come from.
      if (isTorrentSource(source.current) && !isTorrentSource(nextSource))
        Torrents.Release().catch(() => {});
      void navigate({
        to: "/player",
        replace: true,
        state: (current) => ({
          ...current,
          player: {
            ...playerHeading(meta, next.id, nextTarget.title),
            source: nextSource,
            stream: attempt.stream,
            watching: nextWatching,
            resumedAt: start,
            subtitles: subtitleTarget(
              meta.type,
              next.id,
              attempt.stream,
              prepared.names.get(attempt.source) ?? "",
            ),
          },
        }),
      });
    } catch {
      if (!controller.signal.aborted) chooseNext();
    }
  };
  // Another stream of what's playing (#68): resolved as the picker resolves
  // a pick, loaded into this session from where this one is (or stopped),
  // with the same progress kept, in the languages playing now. This one
  // plays on until the new one opens, and one that can't be opened leaves
  // it playing and says why in the switcher.
  const switchStream = async (
    candidate: Candidate,
    names: ReadonlyMap<string, string>,
    refresh: Refresh,
  ) => {
    if (!watching) return;
    const current = playing?.stream;
    if (!error && current && attempts(candidate).some(({ stream }) => sameStream(stream, current)))
      return setSwitcherOpen(false);
    pickAbort.current?.abort();
    const controller = new AbortController();
    pickAbort.current = controller;
    const quality = resolutionLabel(candidate.parsed) ?? "the stream";
    setSwitchStatus({
      text: `Opening ${quality} from ${names.get(candidate.source) ?? "an addon"}…`,
    });
    try {
      // The switcher's refresh asks a plugin's stream of its plugin (#56).
      const { source: picked, attempt } = await resolvePick(candidate, {
        refresh,
        signal: controller.signal,
      });
      const at = error ? stoppedAt.current : (await Player.Snapshot()).position;
      controller.signal.throwIfAborted();
      switching.current = true;
      try {
        await Player.Load(picked, loadOptions(at, settings, lastTracks.current, watching));
      } catch {
        switching.current = false;
        return setSwitchStatus({
          text: "",
          failed: "Sinag’s player couldn’t start it. Try another stream.",
        });
      }
      // The user's choice is the show's source from now on (#58).
      rememberSource(
        queryClient,
        watching.profileId,
        watching.contentType,
        watching.contentId,
        candidate,
        attempt,
      );
      // A torrent playing that the new stream doesn't come from.
      if (isTorrentSource(source.current) && !isTorrentSource(picked))
        Torrents.Release().catch(() => {});
      const subtitles = subtitleTarget(
        watching.contentType,
        watching.videoId,
        attempt.stream,
        names.get(attempt.source) ?? "",
      );
      if (picked.url === source.current?.url) {
        // The same link: this screen plays it on.
        switching.current = false;
        source.current = picked;
        reloaded();
        setError(undefined);
        setSwitchStatus(undefined);
        setSwitcherOpen(false);
        return;
      }
      void navigate({
        to: "/player",
        replace: true,
        state: (history) => ({
          ...history,
          player: {
            ...history.player,
            title: history.player?.title ?? "",
            source: picked,
            stream: attempt.stream,
            resumedAt: 0,
            subtitles,
          },
        }),
      });
    } catch (failure) {
      if (controller.signal.aborted) return;
      const why =
        failure instanceof PlayError
          ? failure
          : new PlayError("unreachable", candidate.parsed.debrid);
      setSwitchStatus({ text: why.message, failed: why.description });
    } finally {
      if (pickAbort.current === controller) pickAbort.current = null;
    }
  };
  // The switcher needs the app window: the mini player leaves for it.
  const openSwitcher = () => {
    if (mini) {
      setMini(false);
      Player.SetMini(false).catch(() => {});
    }
    setSwitchStatus(undefined);
    setSwitcherOpen(true);
  };
  const openParty = () => {
    if (mini) {
      setMini(false);
      Player.SetMini(false).catch(() => {});
    }
    setHelpOpen(false);
    setPartyOpen(!partyOpen);
  };
  // "Start over", while a resumed file has played less than startOverFor.
  const resumedAt = playing?.resumedAt ?? 0;
  const [startOverDone, setStartOverDone] = useState(false);
  const started = ready && !state.loading && known;
  useEffect(() => {
    if (!started || startOverDone) return undefined;
    const timer = setTimeout(() => setStartOverDone(true), startOverFor);
    return () => clearTimeout(timer);
  }, [started, startOverDone]);
  const offerStartOver = resumedAt > 0 && started && !startOverDone;
  const togglePause = () => {
    if (!ready) return;
    setFlash({ id: ++flashes.current, paused: !paused });
    setPaused(!paused);
    Player.SetPaused(!paused).catch(() => {});
  };
  const seek = (to: number) => {
    if (!ready || !known) return;
    const at = Math.min(Math.max(0, to), state.duration);
    setPosition(at);
    seeker({ to: at, exact: true });
  };
  const startOver = () => {
    setStartOverDone(true);
    seek(0);
  };
  // The segment playing, and those skipped already, by kind and start.
  const segment = started ? segmentAt(segments, position) : undefined;
  const skipped = useRef(new Set<string>());
  const skipSegment = (skipping: Segment) => {
    skipped.current.add(`${skipping.kind}:${skipping.start}`);
    seek(skipping.end);
  };
  const autoSkip = settings?.skipIntros === true && !dragging;
  const skipNow = useEffectEvent((skipping: Segment) => {
    skipSegment(skipping);
    setNotice({ text: skipping.kind === "recap" ? "Skipped the recap" : "Skipped the intro" });
  });
  const autoSkipping = segment && autoSkip && segment.kind !== "credits" ? segment : undefined;
  const autoKey = autoSkipping && `${autoSkipping.kind}:${autoSkipping.start}`;
  useEffect(() => {
    if (!autoSkipping || !autoKey || skipped.current.has(autoKey)) return;
    skipNow(autoSkipping);
    // oxlint-disable-next-line react/exhaustive-deps -- once per segment
  }, [autoKey]);
  const changeVolume = (to: number) => {
    setVolume(to);
    volumer(to);
    if (muted && to > 0) toggleMute();
  };
  // The speed (the Speed menu, [ ] and Backspace), through the watch
  // party's gate in Go: a party that only its host controls refuses it.
  const changeSpeed = (to: number) => {
    if (!ready) return;
    setSpeed(to);
    Player.SetSpeed(to).catch(() => {});
    setNotice({ text: to === normalSpeed ? "Normal speed" : `Speed ${speedLabel(to)}` });
  };
  const toggleMute = () => {
    setMuted(!muted);
    Player.SetMuted(!muted).catch(() => {});
  };
  const toggleFullscreen = () => {
    setFullscreen(!fullscreen);
    if (!fullscreen) setMini(false);
    Player.SetFullscreen(!fullscreen).catch(() => {});
  };
  // The mini player has no room for the shortcuts or the switcher.
  const toggleMini = () => {
    if (!mini && !ready) return;
    setMini(!mini);
    if (!mini) {
      setFullscreen(false);
      setHelpOpen(false);
      setSwitcherOpen(false);
      setPictureOpen(false);
      setSpeedOpen(false);
    }
    Player.SetMini(!mini).catch(() => {});
  };
  const pickAudio = (id: number) => {
    setAudioId(id);
    Player.SetAudioTrack(id).catch(() => {});
  };
  // The profile's subtitle language from now on: what the user picked.
  const rememberLanguage = (code: string) => {
    if (code && settings && settings.subtitleLanguage !== code)
      saveSettings.mutate({ ...settings, subtitleLanguage: code } satisfies ProfileSettings);
  };
  const pickSubtitles = (id: number) => {
    autoDone.current = true;
    autoSecondDone.current = true;
    // The same track can't be both lines: the second gives way (Go too).
    if (id === secondaryId) setSecondaryId(0);
    setSubtitleId(id);
    Player.SetSubtitleTrack(id).catch(() => {});
    const track = subtitleTracks.find((each) => each.id === id);
    if (track && !track.forced) rememberLanguage(subtitleLanguage(track.lang).code);
  };
  // Adds an addon's subtitles, or shows them if they were added already.
  const addSubtitles = (subtitle: AddonSubtitle, picked: boolean) => {
    if (picked) {
      autoDone.current = true;
      autoSecondDone.current = true;
      rememberLanguage(subtitle.code);
    }
    const id = added.ids.get(subtitle.key);
    if (id) {
      setSubtitleId(id);
      Player.SetSubtitleTrack(id).catch(() => {});
      return;
    }
    const load = added.load;
    if (picked) setLoadingKey(subtitle.key);
    Player.AddSubtitle({
      url: subtitle.url,
      lang: subtitle.code,
      title: subtitle.addon,
      secondary: false,
    }).then(
      (newId) => {
        setAdded((current) =>
          current.load === load
            ? { load, ids: new Map(current.ids).set(subtitle.key, newId) }
            : current,
        );
        setSubtitleId(newId);
        if (picked) setLoadingKey(undefined);
      },
      () => {
        if (picked) {
          setLoadingKey(undefined);
          setNotice({ text: "Couldn’t load those subtitles" });
        }
      },
    );
  };
  // The second line: a track of the file or an added one, 0 for none.
  const pickSecondary = (id: number) => {
    autoSecondDone.current = true;
    setSecondaryId(id);
    Player.SetSecondarySubtitleTrack(id).catch(() => {
      setSecondaryId(0);
      setNotice({ text: "Couldn’t show those as a second line" });
    });
  };
  // An addon's file as the second line, added if it wasn't yet. `quiet` is
  // for the automatic one, which says nothing if it can't.
  const addSecondary = (subtitle: AddonSubtitle, quiet = false) => {
    autoSecondDone.current = true;
    const id = added.ids.get(subtitle.key);
    if (id) return pickSecondary(id);
    const load = added.load;
    if (!quiet) setLoadingKey(subtitle.key);
    Player.AddSubtitle({
      url: subtitle.url,
      lang: subtitle.code,
      title: subtitle.addon,
      secondary: true,
    }).then(
      (newId) => {
        setAdded((current) =>
          current.load === load
            ? { load, ids: new Map(current.ids).set(subtitle.key, newId) }
            : current,
        );
        setSecondaryId(newId);
        setLoadingKey(undefined);
      },
      () => {
        setLoadingKey(undefined);
        if (!quiet) setNotice({ text: "Couldn’t load those subtitles" });
      },
    );
  };
  const fileReady = ready && !state.loading && tracks.length > 0;
  const captionsOn =
    settings?.captions === "on" || (settings?.captions !== "off" && systemCaptions === true);
  useEffect(() => {
    if (!fileReady || !settings) return;
    if (added.load > 0) {
      // A reload: the addon subtitles that were showing, again.
      if (readdedFor.current === added.load) return;
      readdedFor.current = added.load;
      if (showingAddon.current) addSubtitles(showingAddon.current, false);
      return;
    }
    if (autoDone.current || systemCaptions === undefined) return;
    const auto = autoSubtitle(
      addonSubtitles.subtitles,
      tracks,
      settings.subtitleLanguage,
      captionsOn,
    );
    if (auto || !addonSubtitles.loading) autoDone.current = true;
    if (auto) addSubtitles(auto, false);
  });
  // Which addon subtitles are showing, to add again after a reload. After
  // the effect above, which reads the last load's.
  const addonKey = [...added.ids].find(([, id]) => id === subtitleId)?.[0];
  const secondaryAddonKey = [...added.ids].find(([, id]) => id === secondaryId)?.[0];
  useEffect(() => {
    if (tracks.length === 0) return;
    showingAddon.current = addonKey
      ? addonSubtitles.subtitles.find((subtitle) => subtitle.key === addonKey)
      : undefined;
  });
  // The second line, in the profile's second language, once the main
  // subtitles have settled; or again after a reload, as it was.
  const secondLanguage = settings?.secondSubtitleLanguage ?? "";
  useEffect(() => {
    if (!fileReady || !settings) return;
    if (added.load > 0) {
      const was = showingSecond.current;
      showingSecond.current = undefined;
      if (!was || readdedSecondFor.current === added.load) return;
      readdedSecondFor.current = added.load;
      if ("track" in was) pickSecondary(was.track);
      else addSecondary(was.addon, true);
      return;
    }
    if (autoSecondDone.current || !autoDone.current) return;
    if (!secondLanguage) {
      autoSecondDone.current = true;
      return;
    }
    // Waiting for the main subtitles: a file with none in the profile's
    // language gets none, so there's no second line to put by them.
    if (subtitleId === 0) return;
    const pick = autoSecondary(tracks, addonSubtitles.subtitles, secondLanguage, subtitleId);
    if (pick && "track" in pick) pickSecondary(pick.track.id);
    else if (pick) addSecondary(pick.addon, true);
    else if (!addonSubtitles.loading) autoSecondDone.current = true;
  });
  useEffect(() => {
    if (!fileReady) return;
    const addon = secondaryAddonKey
      ? addonSubtitles.subtitles.find((each) => each.key === secondaryAddonKey)
      : undefined;
    showingSecond.current = addon
      ? { addon }
      : secondaryId > 0 && !secondaryAddonKey
        ? { track: secondaryId }
        : undefined;
  });
  const subtitlesMenu =
    subtitleTracks.length > 0 || addonSubtitles.subtitles.length > 0 || addonSubtitles.loading;
  const timeSubtitles = (to: number) => {
    // In whole steps, so presses add up without float drift.
    const delay = Math.max(-maxSubtitleDelay, Math.min(maxSubtitleDelay, Math.round(to * 10) / 10));
    setSubtitleDelay(delay);
    delayer(delay);
    return delay;
  };
  const timeSubtitlesBy = (by: number) => {
    const delay = timeSubtitles(subtitleDelay + by);
    setNotice({ text: `Subtitles ${subtitleDelayText(delay).toLowerCase()}` });
  };
  const cycleSubtitles = () => {
    const id = nextTrackId([0, ...subtitleTracks.map((track) => track.id)], subtitleId);
    pickSubtitles(id);
    const track = subtitleTracks.find((each) => each.id === id);
    setNotice({ text: track ? `Subtitles: ${trackText(track)}` : "Subtitles off" });
  };
  // Shift+C: the next track for the second line, then none.
  const cycleSecondary = () => {
    const choices = secondChoices(subtitleTracks, subtitleId);
    if (choices.length === 0) {
      return setNotice({ text: "No other subtitles for a second line" });
    }
    const id = nextTrackId([0, ...choices.map((track) => track.id)], secondaryId);
    pickSecondary(id);
    const track = choices.find((each) => each.id === id);
    setNotice({ text: track ? `Second subtitles: ${trackText(track)}` : "Second subtitles off" });
  };
  const cycleAudio = () => {
    const id = nextTrackId(
      audioTracks.map((track) => track.id),
      audioId,
    );
    pickAudio(id);
    const track = audioTracks.find((each) => each.id === id);
    if (track) setNotice({ text: `Audio: ${trackText(track)}` });
  };
  // Muted, up unmutes at the volume it had.
  const stepVolume = (by: number) => {
    if (muted) {
      if (by < 0) return;
      toggleMute();
      return setNotice({ text: `Volume ${Math.round(volume)} %` });
    }
    const to = clampVolume(volume + by, volumeMax);
    changeVolume(to);
    setNotice({ text: `Volume ${to} %` });
  };

  // How subtitles look: the profile's, changed live from the panel or by
  // keys (R and G nudge their place and size). A change lasts until this
  // video ends; "Save as my style" is what makes it the profile's.
  const [subStyle, setSubStyle] = useState<SubtitleStyle>();
  const savedStyle = settings?.subtitleStyle?.font ? settings.subtitleStyle : defaultSubtitleStyle;
  const style = subStyle ?? savedStyle;
  const [styler] = useState(() => latestOnly(Player.SetSubtitleStyle));
  const restyle = setSubStyle;
  // A nudge shows where it put the subtitles for a moment, before they rise
  // for the controls (below) again.
  const [nudgedAt, setNudgedAt] = useState<number>();
  useEffect(() => {
    if (nudgedAt === undefined) return undefined;
    const timer = setTimeout(() => setNudgedAt(undefined), nudgeShown);
    return () => clearTimeout(timer);
  }, [nudgedAt]);
  const styleUnsaved = JSON.stringify(style) !== JSON.stringify(savedStyle);
  const saveStyle = () => {
    if (!settings) return;
    saveSettings.mutate({ ...settings, subtitleStyle: style } satisfies ProfileSettings);
    setSubStyle(undefined);
    setNotice({ text: "Saved as your subtitle style" });
  };
  // R raises the subtitles and Shift+R lowers them; G shrinks them and
  // Shift+G grows them. Each shows at once and says where it left them.
  const nudgeSubtitles = (lift: number, size: number) => {
    if (!ready || mini || subtitleTracks.length === 0) return;
    const lifted = nudgeLift(style.lift, lift);
    const sized = nudgeSize(style.size, size);
    if (lifted === style.lift && sized === style.size) {
      return setNotice({
        text: size
          ? `Subtitles at their ${size < 0 ? "smallest" : "largest"}`
          : `Subtitles as ${lift > 0 ? "high" : "low"} as they go`,
      });
    }
    restyle({ ...style, lift: lifted, size: sized });
    if (lift) setNudgedAt(Date.now());
    setNotice({ text: size ? `Subtitle size ${sized} %` : `Subtitles: ${liftText(lifted)}` });
  };
  const openPanel = (tab: PanelTab) => {
    if (mini) return;
    setHelpOpen(false);
    setPictureOpen(false);
    setPanel(panel === tab ? undefined : tab);
  };

  // The picture (P): the title's own, else the profile's (lib/picture.ts),
  // as Go applied it at load. A change shows at once and is kept for the
  // title (a show's id for every episode); a file nothing names keeps it
  // until it ends.
  const titleKey = watching && profileId > 0 ? watching.contentId : "";
  const adjustments = useQuery({
    ...titleAdjustmentsQuery(profileId, titleKey),
    enabled: titleKey !== "",
  }).data;
  const saveAdjustments = useSaveTitleAdjustments(profileId, titleKey);
  const [unsavedPicture, setUnsavedPicture] = useState<Picture>();
  const picture = unsavedPicture ?? pictureOf(settings, adjustments);
  const namedPictures = settings?.picturePresets ?? [];
  const [picturer] = useState(() => latestOnly(Player.SetPicture));
  const changePicture = (changed: Picture) => {
    picturer(changed);
    if (!titleKey) {
      setUnsavedPicture(changed);
      return;
    }
    saveAdjustments.mutate(withSection(adjustments, "picture", changed));
  };
  const resetPicture = () => {
    setUnsavedPicture(undefined);
    picturer(settings?.picture ?? standardPicture);
    if (titleKey) saveAdjustments.mutate(withSection(adjustments, "picture", undefined));
  };
  const pictureForAll = () => {
    if (!settings) return;
    saveSettings.mutate({ ...settings, picture } satisfies ProfileSettings);
    setUnsavedPicture(undefined);
    if (titleKey && adjustments?.picture) {
      saveAdjustments.mutate(withSection(adjustments, "picture", undefined));
    }
    setNotice({ text: "Picture set for all titles" });
  };
  const savePicturePreset = (name: string) => {
    const presets = settings && savePreset(namedPictures, name, picture);
    if (!settings || !presets) return;
    saveSettings.mutate({ ...settings, picturePresets: presets } satisfies ProfileSettings);
    changePicture({ ...picture, preset: userPreset(name.trim()) });
    setNotice({ text: `Saved “${name.trim()}”` });
  };
  // The framing (the sheet's Framing tab, Shift+F, Shift+A, = − 0, ⌥ and the
  // arrows, a drag while zoomed): kept for the title like the picture.
  const [sheetTab, setSheetTab] = useState<PictureSheetTab>("picture");
  const [unsavedFraming, setUnsavedFraming] = useState<Framing>();
  const framing = unsavedFraming ?? framingOf(settings, adjustments);
  const [framer] = useState(() => latestOnly(Player.SetFraming));
  const changeFraming = (changed: Framing) => {
    framer(changed);
    if (!titleKey) {
      setUnsavedFraming(changed);
      return;
    }
    saveAdjustments.mutate(withSection(adjustments, "framing", changed));
  };
  const resetFraming = () => {
    setUnsavedFraming(undefined);
    framer(framingOf(settings, null));
    if (titleKey) saveAdjustments.mutate(withSection(adjustments, "framing", undefined));
  };
  const framingForAll = () => {
    if (!settings) return;
    const { fit, autoCrop } = framing;
    saveSettings.mutate({
      ...settings,
      framing: { ...defaultFraming, fit, autoCrop },
    } satisfies ProfileSettings);
    setNotice({ text: "Fit and black bars set for all titles" });
  };
  const cycleFit = () => {
    const fit = cycle<string>(
      fitModes.map(({ id }) => id),
      framing.fit,
    );
    changeFraming({ ...framing, fit });
    setNotice({ text: fitName(fit) });
  };
  const cycleAspect = () => {
    const ids: string[] = aspectRatios.map(({ id }) => id);
    const aspect = ids.includes(framing.aspect) ? cycle(ids, framing.aspect) : "auto";
    changeFraming({ ...framing, aspect });
    setNotice({ text: `Aspect ${aspectName(aspect)}` });
  };
  const zoom = (steps: number) => {
    const changed = zoomBy(framing, steps);
    changeFraming(changed);
    setNotice({ text: `Zoom ${zoomLabel(changed.zoom)}` });
  };
  // A drag on the video while zoomed moves the picture: by its own width
  // and height (mpv's pan), so the share of the window it was dragged
  // divided by the zoom. Let go, it's kept; a drag isn't a click.
  const panDrag = useRef<{ x: number; y: number; start: Framing; last?: Framing }>(undefined);
  const dragged = useRef(false);
  // How hard the renderer works (the sheet's Quality tab): the title's own,
  // else this device's.
  const device = useQuery(deviceSettingsQuery).data;
  const saveDevice = useSaveDeviceSettings();
  const [unsavedQuality, setUnsavedQuality] = useState<Quality>();
  const quality = unsavedQuality ?? qualityOf(device, adjustments);
  const [qualifier] = useState(() => latestOnly(Player.SetQuality));
  const changeQuality = (changed: Quality) => {
    qualifier(changed);
    if (!titleKey) {
      setUnsavedQuality(changed);
      return;
    }
    saveAdjustments.mutate(withSection(adjustments, "quality", changed));
  };
  const resetQuality = () => {
    setUnsavedQuality(undefined);
    qualifier(qualityOf(device, null));
    if (titleKey) saveAdjustments.mutate(withSection(adjustments, "quality", undefined));
  };
  const qualityForAll = () => {
    if (!device) return;
    saveDevice.mutate({ ...device, quality });
    setUnsavedQuality(undefined);
    if (titleKey && adjustments?.quality) {
      saveAdjustments.mutate(withSection(adjustments, "quality", undefined));
    }
    setNotice({ text: "Quality set for this device" });
  };
  // How it sounds (the sheet's Sound tab, B): the title's own, else the
  // profile's; the output is this device's; the delay is this video's.
  const [unsavedSound, setUnsavedSound] = useState<Sound>();
  const sound = unsavedSound ?? soundOf(settings, adjustments);
  const [sounder] = useState(() => latestOnly(Player.SetSound));
  const changeSound = (changed: Sound) => {
    sounder(changed);
    if (!titleKey) {
      setUnsavedSound(changed);
      return;
    }
    saveAdjustments.mutate(withSection(adjustments, "sound", changed));
  };
  const resetSound = () => {
    setUnsavedSound(undefined);
    sounder(soundOf(settings, null));
    if (titleKey) saveAdjustments.mutate(withSection(adjustments, "sound", undefined));
  };
  const soundForAll = () => {
    if (!settings) return;
    saveSettings.mutate({ ...settings, sound } satisfies ProfileSettings);
    setUnsavedSound(undefined);
    if (titleKey && adjustments?.sound) {
      saveAdjustments.mutate(withSection(adjustments, "sound", undefined));
    }
    setNotice({ text: "Sound set for all titles" });
  };
  const toggleDialogue = () => {
    const dialogueBoost = !sound.dialogueBoost;
    changeSound({ ...sound, dialogueBoost });
    setNotice({ text: dialogueBoost ? "Dialogue boost on" : "Dialogue boost off" });
  };
  const audio = audioOf(device);
  const [audioer] = useState(() => latestOnly(Player.SetAudio));
  const changeAudio = (changed: Audio) => {
    audioer(changed);
    if (device) saveDevice.mutate({ ...device, audio: changed });
  };
  const [audioDelay, setAudioDelay] = useAhead(state.audioDelay ?? 0, near);
  const [audioDelayer] = useState(() => latestOnly(Player.SetAudioDelay));
  const changeAudioDelay = (to: number) => {
    setAudioDelay(to);
    audioDelayer(to);
  };
  const audioDevices = useQuery({
    queryKey: ["player", "audio-devices"],
    queryFn: async () => (await Player.AudioDevices()) ?? [],
    enabled: pictureOpen && sheetTab === "sound",
  }).data;
  const surround =
    (tracks.find((track) => track.type === "audio" && track.selected)?.channels ?? 0) > 2;
  const openPicture = () => {
    if (mini) return;
    setHelpOpen(false);
    setPanel(undefined);
    setPictureOpen(!pictureOpen);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // R and G nudge the subtitles: the controls staying hidden shows where
      // they really go.
      const nudging =
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "r" || event.key === "R" || event.key === "g" || event.key === "G");
      if (!nudging) wake();
      // The switcher has the keys: Esc closes it, Space picks. The panel
      // keeps them too, but for Z and X (timing) and Esc (closes it).
      if (error || switcherOpen || partyOpen || dockMenuOpen) return;
      if (event.metaKey || event.ctrlKey) return;
      // Option and the arrows pan the picture (mpv's keys); Option changes
      // event.key on macOS, so these go by event.code. Nothing else takes
      // Option, so the OS keeps its own.
      if (event.altKey) {
        const pans: Record<string, [number, number]> = {
          ArrowLeft: [-0.05, 0],
          ArrowRight: [0.05, 0],
          ArrowUp: [0, -0.05],
          ArrowDown: [0, 0.05],
        };
        const by = pans[event.code];
        if (!by || panel || pictureOpen || !ready || mini) return;
        event.preventDefault();
        if (event.type === "keydown") changeFraming(panBy(framing, by[0], by[1]));
        return;
      }
      if (panel || pictureOpen) {
        const key = event.key.toLowerCase();
        if (event.type !== "keydown") return;
        if (key === "escape") {
          setPanel(undefined);
          setPictureOpen(false);
        }
        // P closes the sheet it opened, unless it's typed (a preset's name).
        const typing = event.target instanceof HTMLInputElement;
        if (pictureOpen && key === "p" && !typing) setPictureOpen(false);
        if (!panel) return;
        if ((key === "z" || key === "x") && ready && subtitleTracks.length > 0) {
          event.preventDefault();
          timeSubtitles(subtitleDelay + (key === "z" ? -delayStep : delayStep));
        }
        return;
      }
      // Not a click on the focused button too, as its key comes up.
      if (event.key === " ") event.preventDefault();
      if (event.type !== "keydown") return;
      // Shift and a letter: its own key, unless it has none (then the
      // letter's, as before).
      const shifted: Record<string, () => void> = {
        F: () => ready && !mini && cycleFit(),
        A: () => ready && !mini && cycleAspect(),
        C: () => ready && !mini && cycleSecondary(),
      };
      // Held down, these go on.
      const shiftedRepeating: Record<string, () => void> = {
        R: () => nudgeSubtitles(-liftStep, 0),
        G: () => nudgeSubtitles(0, sizeStep),
      };
      const shiftedAction = event.shiftKey
        ? (shiftedRepeating[event.key] ?? (event.repeat ? undefined : shifted[event.key]))
        : undefined;
      if (shiftedAction) {
        event.preventDefault();
        shiftedAction();
        return;
      }
      // Keys held down repeat these; the rest act once a press.
      const repeating: Record<string, () => void> = {
        "=": () => ready && !mini && zoom(1),
        "+": () => ready && !mini && zoom(1),
        "-": () => ready && !mini && zoom(-1),
        arrowleft: () => seek(position - skip),
        arrowright: () => seek(position + skip),
        arrowup: () => stepVolume(volumeStep),
        arrowdown: () => stepVolume(-volumeStep),
        z: () => ready && subtitleTracks.length > 0 && timeSubtitlesBy(-delayStep),
        x: () => ready && subtitleTracks.length > 0 && timeSubtitlesBy(delayStep),
        r: () => nudgeSubtitles(liftStep, 0),
        g: () => nudgeSubtitles(0, -sizeStep),
      };
      const once: Record<string, () => void> = {
        " ": togglePause,
        k: togglePause,
        m: toggleMute,
        f: toggleFullscreen,
        i: toggleMini,
        c: () => ready && subtitleTracks.length > 0 && cycleSubtitles(),
        v: () => ready && subtitlesMenu && openPanel("subtitles"),
        p: () => ready && openPicture(),
        b: () => ready && toggleDialogue(),
        "0": () => {
          if (!ready || mini || (framing.zoom === 0 && !framing.panX && !framing.panY)) return;
          changeFraming(unzoomed(framing));
          setNotice({ text: "Zoom 1×" });
        },
        a: () => ready && audioTracks.length > 1 && cycleAudio(),
        "[": () => changeSpeed(stepSpeed(speed, -1)),
        "]": () => changeSpeed(stepSpeed(speed, 1)),
        backspace: () => speed !== normalSpeed && changeSpeed(normalSpeed),
        s: () => watching && openSwitcher(),
        w: () => (watching || party) && openParty(),
        "?": () => !mini && setHelpOpen(!helpOpen),
        escape: () => {
          if (helpOpen) setHelpOpen(false);
          else if (mini) toggleMini();
          else if (fullscreen) toggleFullscreen();
          else leave();
        },
      };
      const key = event.key.toLowerCase();
      // A focused slider moves itself with the arrows.
      if (key.startsWith("arrow") && event.defaultPrevented) return;
      const action = repeating[key] ?? (event.repeat ? undefined : once[key]);
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  });

  const failure = error && ((!torrent && failures[error.code ?? ""]) || failed);
  const seekingLate = useLate(state.seeking, 300);
  const waiting = starting || (!failure && (state.loading || state.buffering || seekingLate));
  const shown =
    !idle ||
    paused ||
    !ready ||
    state.loading ||
    dragging ||
    over ||
    menuOpen ||
    helpOpen ||
    switcherOpen ||
    partyOpen ||
    dockMenuOpen;
  // The subtitles rise to clear the controls while they show, and settle
  // back when they hide. The user's own lift doesn't add to that: the
  // higher of the two wins, so a lift set to dodge the controls once doesn't
  // leave them too high the rest of the time. Nudging, or the Style tab's
  // Position slider, shows the lift itself.
  const windowHeight = useWindowHeight();
  const previewing = nudgedAt !== undefined || panel === "style";
  const lifted = liftNow(
    style.lift,
    shown && !previewing && ready,
    liftToClear(windowHeight, mini),
  );
  const loaded = settings !== undefined;
  useEffect(() => {
    // A new file starts with the profile's style (Go sets it at load).
    if (!ready || state.loading || !loaded) return;
    styler({ ...style, lift: lifted });
  }, [style, lifted, ready, state.loading, loaded, added.load, styler]);
  const hold = { onPointerEnter: () => setOver(true), onPointerLeave: () => setOver(false) };
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  // Hours show once the file is that long; the times keep one width so the
  // seek bar between them doesn't shift as they count.
  const hours = state.duration >= 3600;
  const timeShown = known && !mini;
  const waitingText =
    (starting && next !== undefined) ||
    (!starting && ((state.buffering && state.bufferPercent > 0) || torrentStatus?.active));

  const playButton = (
    <ControlButton
      label={paused ? "Play" : "Pause"}
      icon={paused ? Play : Pause}
      onClick={togglePause}
      aria-keyshortcuts="Space K"
      disabled={!ready}
      fill
      large={!mini}
    />
  );
  const volumeControl = (
    <div className="group/volume flex items-center">
      <ControlButton
        label={muted ? "Unmute" : "Mute"}
        icon={VolumeIcon}
        onClick={toggleMute}
        aria-keyshortcuts="M"
      />
      <Slider.Root
        value={muted ? 0 : volume}
        min={0}
        max={volumeMax}
        onValueChange={changeVolume}
        // Always there in the bar; the mini player has no room, so it opens
        // on hover or focus as before.
        className={cn(
          mini &&
            "w-0 overflow-hidden opacity-0 transition-[width,opacity] duration-200 group-focus-within/volume:w-24 group-focus-within/volume:opacity-100 group-hover/volume:w-24 group-hover/volume:opacity-100",
          !mini &&
            "w-0 overflow-hidden opacity-0 transition-[width,opacity] duration-300 ease-out-soft group-focus-within/volume:w-24 group-focus-within/volume:opacity-100 group-hover/volume:w-24 group-hover/volume:opacity-100",
        )}
      >
        <Slider.Control className="flex h-8 cursor-pointer touch-none items-center px-2 select-none">
          <Slider.Track className="relative h-1 w-full rounded-full bg-white/25">
            <Slider.Indicator className="rounded-full bg-white" />
            <Slider.Thumb
              aria-label="Volume"
              className="size-3 rounded-full bg-white shadow-md outline-none has-focus-visible:ring-2 has-focus-visible:ring-white/60"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
    </div>
  );
  const miniButton = (
    <ControlButton
      label={mini ? "Exit mini player" : "Mini player"}
      icon={PictureInPicture2}
      onClick={toggleMini}
      aria-keyshortcuts="I"
      disabled={!mini && !ready}
    />
  );

  // The prompts (resume, skip, up next) share one place: right above the
  // dock's right end while the controls show, and down in the corner when
  // they hide, so they never jump about or cover the controls.
  const prompts = !failure && (
    <div
      className={cn(
        "pointer-events-none absolute end-0 flex flex-col items-end gap-2.5 transition-[bottom] duration-300 ease-out-soft *:pointer-events-auto",
        mini ? "inset-x-2 bottom-16 items-stretch" : "pe-8",
        !mini && (shown ? "bottom-[calc(var(--dock-h)+1.25rem)]" : "bottom-8"),
      )}
    >
      {partyElsewhere && !mini && (
        <Prompt
          {...hold}
          icon={<Users />}
          action={
            party?.isHost && media ? (
              <Button
                size="sm"
                variant="light"
                onClick={() => void Party.SwitchTo(media).catch(() => {})}
              >
                Switch the party to this
              </Button>
            ) : partyIsNext ? (
              <Button size="sm" variant="light" onClick={() => setStarting(true)}>
                Play it
              </Button>
            ) : (
              <Button
                size="sm"
                variant="light"
                onClick={() => watchWithParty(partyElsewhere, true)}
              >
                Watch with the party
              </Button>
            )
          }
        >
          The party is watching {mediaLabel(partyElsewhere)}
        </Prompt>
      )}
      {offerStartOver && !mini && (
        <Prompt
          {...hold}
          icon={<Resumed />}
          action={
            <Button size="sm" variant="light" onClick={startOver}>
              <RotateCcw />
              Start over
            </Button>
          }
        >
          Resumed at <span className="tnum">{formatTime(resumedAt)}</span>
        </Prompt>
      )}
      {segment && !(segment.kind === "credits" && meta && next && (counting || starting)) && (
        <div {...hold} className={promptEnter}>
          <Button
            size={mini ? "sm" : "lg"}
            variant="light"
            className="shadow-[0_18px_48px_-12px_rgb(0_0_0/0.7)]"
            onClick={() => skipSegment(segment)}
          >
            {skipLabels[segment.kind]}
            <SkipForward className="fill-current" />
          </Button>
        </div>
      )}
      {meta && next && (counting || starting) && (
        <NextEpisode
          profileId={profileId}
          meta={meta}
          next={next}
          settings={settings}
          remaining={Math.max(0, state.duration - state.position)}
          share={from === undefined ? 0 : (state.position - from) / (state.duration - from)}
          starting={starting}
          mini={mini}
          onPlay={() => setStarting(true)}
          onCancel={() => setCancelled(true)}
          onStart={(prepared) => void playNext(prepared)}
        />
      )}
    </div>
  );

  return (
    <div
      // --above-bar is where the overlays sit: above the dock.
      className={cn(
        "fixed inset-0 text-white select-none [--dock-h:7.5rem]",
        mini ? "[--above-bar:6.25rem]" : "[--above-bar:calc(var(--dock-h)+1.5rem)]",
        !shown && "cursor-none",
      )}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      {/* The video itself: a click pauses, a double click goes fullscreen
          (or, from the mini player, back to the app window). The Play
          button is the one to reach by keyboard. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className={cn(
          "absolute inset-0 outline-none",
          !shown ? "cursor-none" : framing.zoom !== 0 && ready ? "cursor-grab" : "cursor-default",
        )}
        onPointerDown={(event) => {
          if (!ready || mini || framing.zoom === 0 || event.button !== 0) return;
          panDrag.current = { x: event.clientX, y: event.clientY, start: framing };
          dragged.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = panDrag.current;
          if (!drag) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (!dragged.current && Math.hypot(dx, dy) < 4) return;
          dragged.current = true;
          const box = event.currentTarget.getBoundingClientRect();
          const scale = 2 ** drag.start.zoom;
          drag.last = panBy(drag.start, dx / (box.width * scale), dy / (box.height * scale));
          framer(drag.last);
        }}
        onPointerUp={() => {
          const drag = panDrag.current;
          panDrag.current = undefined;
          if (drag?.last) changeFraming(drag.last);
        }}
        onPointerCancel={() => {
          panDrag.current = undefined;
        }}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          if (panel || pictureOpen) {
            setPanel(undefined);
            setPictureOpen(false);
          } else togglePause();
        }}
        onDoubleClick={mini ? toggleMini : toggleFullscreen}
      />
      {/* The second line of subtitles, over the video and under the
          controls. The mini player has no room for it. */}
      {ready && !mini && !failure && !state.loading && secondaryId > 0 && (
        <SecondSubtitles
          text={state.secondarySubtitleText ?? ""}
          mainText={state.subtitleText ?? ""}
          mainOn={subtitleId > 0}
          style={style}
          lift={lifted}
        />
      )}
      <div
        data-testid="controls"
        data-shown={shown || undefined}
        className={cn(
          "transition-opacity duration-300",
          shown ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {/* Scrims: a band at the top for the title, a deeper one at the
            bottom for the dock. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 bg-linear-to-b from-black/60 via-black/20 to-transparent",
            mini ? "h-16" : "h-36",
          )}
        />
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/75 via-black/30 to-transparent",
            mini ? "h-24" : "h-64",
          )}
        />

        {/* The top: Back and what's playing on the left; the window's
            actions on the right. A drag strip, clear of the traffic lights. */}
        <div
          {...hold}
          className={cn(
            "drag-region absolute inset-x-0 top-0 flex items-start gap-4",
            mini ? "h-14 pt-2 pr-3 pl-2" : "pt-3 pr-5 pl-[5.75rem]",
          )}
        >
          <ControlButton label="Back" icon={ChevronLeft} onClick={leave} raised />
          {playing?.title && (
            <div
              className={cn(
                "flex min-w-0 flex-col drop-shadow-[0_1px_8px_rgb(0_0_0/0.6)]",
                mini ? "h-10 justify-center" : "gap-1.5 pt-0.5",
              )}
            >
              <h1
                className={cn(
                  "truncate",
                  mini
                    ? "text-sm font-semibold"
                    : "font-display text-[1.875rem] leading-none font-normal",
                )}
              >
                {playing.title}
              </h1>
              {playing.episode && (
                <p className={cn("truncate", mini ? "text-small" : "text-small text-white/75")}>
                  {playing.episode}
                </p>
              )}
            </div>
          )}
          {!mini && (
            <div className="ms-auto flex shrink-0 items-center gap-1">
              {torrentStatus?.active && (
                <p
                  aria-label="Torrent status"
                  className="me-2 rounded-full bg-black/45 px-3 py-1.5 text-small text-white/85 tnum backdrop-blur-md"
                >
                  {torrentStatusText(torrentStatus)}
                </p>
              )}
              {(watching || party) && (
                <ControlButton
                  label={party ? "Watch party" : "Start a watch party"}
                  icon={Users}
                  onClick={openParty}
                  aria-keyshortcuts="W"
                  aria-expanded={partyOpen}
                  className={cn(
                    party && "bg-white/12",
                    partyChat.unread > 0 &&
                      "after:absolute after:top-1.5 after:right-1.5 after:size-2 after:rounded-full after:bg-[#ffb547]",
                  )}
                />
              )}
              {watching && (
                <ControlButton
                  label="Streams"
                  icon={ListVideo}
                  onClick={openSwitcher}
                  aria-keyshortcuts="S"
                  aria-expanded={switcherOpen}
                />
              )}
              <ControlButton
                label="Keyboard shortcuts"
                icon={Keyboard}
                onClick={() => {
                  setPanel(undefined);
                  setPictureOpen(false);
                  setHelpOpen(!helpOpen);
                }}
                aria-keyshortcuts="Shift+?"
                aria-expanded={helpOpen}
              />
              {miniButton}
              <ControlButton
                label={fullscreen ? "Exit full screen" : "Full screen"}
                icon={fullscreen ? Minimize : Maximize}
                onClick={toggleFullscreen}
                aria-keyshortcuts="F"
              />
            </div>
          )}
        </div>

        {/* The dock: the timeline across, and the transport under it. */}
        <div
          {...hold}
          className={cn(
            "absolute flex flex-col",
            mini
              ? "inset-x-2 bottom-2 gap-1 rounded-2xl px-3 py-2 material-media"
              : "inset-x-0 bottom-0 h-(--dock-h) justify-end gap-1 px-8 pb-5",
          )}
        >
          <div className="flex items-center gap-4">
            {timeShown && (
              <p
                data-testid="elapsed"
                className={cn(
                  "shrink-0 text-small font-[590] text-white tnum",
                  hours ? "w-[7ch]" : "w-[5ch]",
                )}
              >
                {formatTime(position)}
              </p>
            )}
            <div className="min-w-0 flex-1">
              <SeekBar
                position={position}
                duration={state.duration}
                buffered={state.buffered}
                segments={segments}
                playing={!paused && ready}
                onScrub={(to) => ready && seeker({ to, exact: false })}
                onSeek={seek}
                onDraggingChange={setDragging}
              />
            </div>
            {timeShown && (
              <p
                data-testid="remaining"
                className={cn(
                  "shrink-0 text-end text-small font-[590] text-white/70 tnum",
                  hours ? "w-[8ch]" : "w-[6ch]",
                )}
              >
                -{formatTime(Math.max(0, state.duration - position))}
              </p>
            )}
          </div>
          {mini ? (
            <div className="flex items-center gap-1">
              {playButton}
              {volumeControl}
              {known && (
                <p className="ms-1 truncate text-small text-white tnum">
                  {formatTime(position)} / {formatTime(state.duration)}
                </p>
              )}
              <div className="ms-auto flex items-center gap-1">{miniButton}</div>
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_auto_1fr] items-center">
              <div className="flex items-center gap-1">{volumeControl}</div>
              <div className="flex items-center gap-4">
                <ControlButton
                  label="Back 10 seconds"
                  icon={RotateCcw}
                  aria-keyshortcuts="ArrowLeft"
                  onClick={() => seek(position - skip)}
                  disabled={!ready || !known}
                  badge={skip}
                />
                {playButton}
                <ControlButton
                  label="Forward 10 seconds"
                  icon={RotateCw}
                  aria-keyshortcuts="ArrowRight"
                  onClick={() => seek(position + skip)}
                  disabled={!ready || !known}
                  badge={skip}
                />
              </div>
              <div className="flex items-center justify-self-end gap-1.5">
                {ready && (
                  <SpeedMenu
                    speed={speed}
                    onChange={changeSpeed}
                    open={speedOpen}
                    onOpenChange={setSpeedOpen}
                  />
                )}
                {ready && subtitlesMenu && (
                  <PanelButton
                    label="Subtitles"
                    icon={Captions}
                    active={panel !== undefined && panel !== "audio"}
                    on={subtitleId > 0}
                    onClick={() => openPanel("subtitles")}
                    shortcut="V"
                  />
                )}
                {ready && audioTracks.length > 1 && (
                  <PanelButton
                    label="Audio"
                    icon={AudioLines}
                    active={panel === "audio"}
                    onClick={() => openPanel("audio")}
                  />
                )}
                {ready && (
                  <PanelButton
                    label="Picture and sound"
                    icon={SlidersHorizontal}
                    active={pictureOpen}
                    on={
                      picture.preset !== "standard" ||
                      JSON.stringify(framing) !== JSON.stringify(defaultFraming)
                    }
                    onClick={openPicture}
                    shortcut="P"
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {prompts}
      <SubtitlePanel
        open={panel !== undefined && !mini && !failure}
        tab={panel ?? "subtitles"}
        onTabChange={setPanel}
        onClose={() => setPanel(undefined)}
        subtitleTracks={subtitleTracks}
        addedIds={new Set(added.ids.values())}
        subtitleId={subtitleId}
        onPickTrack={pickSubtitles}
        addonSubtitles={addonSubtitles.subtitles}
        addonLoading={addonSubtitles.loading}
        addonKey={addonKey}
        loadingKey={loadingKey}
        onPickAddon={(subtitle) => addSubtitles(subtitle, true)}
        secondaryId={secondaryId}
        secondaryAddonKey={secondaryAddonKey}
        onPickSecondaryTrack={pickSecondary}
        onPickSecondaryAddon={(subtitle) => addSecondary(subtitle)}
        preferredLanguage={settings?.subtitleLanguage ?? ""}
        audioTracks={audioTracks}
        audioId={audioId}
        onPickAudio={pickAudio}
        style={style}
        onStyleChange={restyle}
        save={{ unsaved: styleUnsaved, onSave: saveStyle }}
        delay={subtitleDelay}
        onDelayChange={timeSubtitles}
        position={position}
        subtitleText={state.subtitleText ?? ""}
      />
      <PictureSheet
        open={pictureOpen && !mini && !failure}
        onClose={() => setPictureOpen(false)}
        tab={sheetTab}
        onTabChange={setSheetTab}
        title={watching?.name || playing?.title || "this title"}
        saves={titleKey !== ""}
        picture={{
          picture,
          presets: namedPictures,
          own: adjustments?.picture != null || unsavedPicture !== undefined,
          onPreview: picturer,
          onChange: changePicture,
          onReset: resetPicture,
          onUseForAll: pictureForAll,
          onSavePreset: savePicturePreset,
        }}
        framing={{
          framing,
          own: adjustments?.framing != null || unsavedFraming !== undefined,
          found: state.autoCrop ?? undefined,
          onPreview: framer,
          onChange: changeFraming,
          onReset: resetFraming,
          onUseForAll: framingForAll,
        }}
        sound={{
          sound,
          own: adjustments?.sound != null || unsavedSound !== undefined,
          onChange: changeSound,
          onReset: resetSound,
          onUseForAll: soundForAll,
          delay: audioDelay,
          onDelayChange: changeAudioDelay,
          audio,
          devices: audioDevices ?? [],
          onAudioChange: changeAudio,
          surround,
        }}
        quality={{
          quality,
          own: adjustments?.quality != null || unsavedQuality !== undefined,
          hdrShown: state.hdr,
          onPreview: qualifier,
          onChange: changeQuality,
          onReset: resetQuality,
          onUseForAll: qualityForAll,
        }}
      />
      {watching && (
        <StreamSwitcher
          open={switcherOpen}
          onOpenChange={(open) => {
            setSwitcherOpen(open);
            // Closing gives up on a stream still opening.
            if (!open) pickAbort.current?.abort();
          }}
          watching={watching}
          title={playing?.title ?? ""}
          playing={playing?.stream}
          status={switchStatus}
          onPick={(candidate, names, refresh) => void switchStream(candidate, names, refresh)}
        />
      )}
      <PartySheet
        open={partyOpen && !mini}
        onOpenChange={setPartyOpen}
        state={partyState}
        media={media}
        canShare={shared !== undefined}
      />
      {!mini && !failure && (
        <PartyPill
          state={partyState}
          notice={partyNotice}
          onCatchUp={() => void Party.CatchUp().catch(() => {})}
        />
      )}
      {helpOpen && !failure && !mini && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}
      {notice && !failure && (
        <div
          aria-live="polite"
          className={cn(
            "pointer-events-none absolute inset-x-0 flex justify-center",
            mini ? "top-14" : "top-24",
          )}
        >
          <p className="rounded-full bg-black/65 px-4 py-2 text-small font-[600] text-white shadow-float backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95">
            {notice.text}
          </p>
        </div>
      )}
      {flash && !failure && (
        // A click or key on the video: the state it went to, for a moment.
        // The button's own label already says it, so this is for the eye.
        <div
          key={flash.id}
          aria-hidden
          data-testid="playback-flash"
          className="pointer-events-none absolute inset-0 grid place-items-center"
        >
          <div className="grid size-24 place-items-center rounded-full bg-black/40 text-white opacity-0 backdrop-blur-md transition-[opacity,scale] duration-500 ease-out starting:scale-75 starting:opacity-100 motion-reduce:starting:scale-100">
            {flash.paused ? (
              <Pause className="size-10 fill-current" />
            ) : (
              <Play className="size-10 translate-x-0.5 fill-current" />
            )}
          </div>
        </div>
      )}
      {failure ? (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-black/80 p-6">
          <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
            <AlertCircle className="size-9 text-[#ffc46b]" />
            <p className="font-display text-[2.25rem] leading-none">{failure.title}</p>
            <p className="text-body text-white/70">{failure.description}</p>
            <div className="mt-3 flex gap-2.5">
              {failure.retry && playing?.source && (
                <Button
                  variant="light"
                  size="lg"
                  onClick={() => void retry(error)}
                  disabled={retrying}
                >
                  {retrying && <Spinner />}
                  Try again
                </Button>
              )}
              <Button
                variant="media"
                size="lg"
                onClick={watching ? openSwitcher : leave}
                disabled={retrying}
              >
                Choose another stream
              </Button>
            </div>
          </div>
        </div>
      ) : (
        waiting && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3">
              <Spinner className="size-11 text-white drop-shadow-[0_2px_12px_rgb(0_0_0/0.6)]" />
              {waitingText && (
                <p className="rounded-full bg-black/55 px-3.5 py-1.5 text-small font-[560] tnum backdrop-blur-md">
                  {starting && next
                    ? `Opening ${episodeCode(next)}…`
                    : torrentStatus?.active
                      ? torrentStatusText(torrentStatus)
                      : `Buffering ${state.bufferPercent} %`}
                </p>
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}

const same = <T,>(a: T, b: T) => a === b;
const near = (a: number, b: number) => Math.abs(a - b) < 1.5;

// on, once it has been on for ms: a seek that lands at once shows nothing.
function useLate(on: boolean, ms: number) {
  const [late, setLate] = useState(false);
  if (!on && late) setLate(false);
  useEffect(() => {
    if (!on) return undefined;
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && late;
}

// "English · SDH": a track, in a line.
function trackText(track: Track): string {
  const { name, detail } = trackLabel(track);
  return detail ? `${name} · ${detail}` : name;
}

// The id of the track that's selected, 0 for none.
function selectedId(tracks: Track[]): number {
  return tracks.find((track) => track.selected)?.id ?? 0;
}

// A dock button that opens the panel at its tab: lit while the panel is
// open there, with a sun dot while subtitles are on.
function PanelButton({
  label,
  icon: Icon,
  active,
  on = false,
  onClick,
  shortcut,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  on?: boolean;
  onClick: () => void;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={active}
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      className={cn(
        "relative grid size-10 place-items-center rounded-full outline-none transition-[background-color,color,scale] focus-visible:ring-2 focus-visible:ring-white/70 motion-safe:active:scale-90 [&_svg]:size-5",
        active ? "bg-white text-black" : "text-white/90 hover:bg-white/12 hover:text-white",
      )}
    >
      <Icon />
      {on && !active && (
        <span
          aria-hidden
          className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[#ffb547]"
        />
      )}
    </button>
  );
}

// A round button for the controls. In the bar it's bare (the bar is the
// material-pop); `material-pop` makes it a media-glass circle of its own, over the video
// (Back). `large` is the Play button. The material-pop ones keep their tint on hover
// (the ghost variant's hover colour would replace it) and lighten the
// highlight instead.
function ControlButton({
  label,
  icon: Icon,
  fill,
  badge,
  raised,
  large,
  className,
  ...props
}: {
  label: string;
  icon: LucideIcon;
  fill?: boolean;
  badge?: ReactNode;
  raised?: boolean;
  large?: boolean;
} & Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      className={cn(
        "relative rounded-full text-white/90 hover:bg-white/12 hover:text-white data-popup-open:bg-white/15",
        raised && "size-10 material-media hover:bg-[rgb(60_56_52/0.55)]",
        large && "size-14 bg-white text-black hover:bg-white/90 hover:text-black",
        className,
      )}
      {...props}
    >
      <Icon className={cn(large ? "size-6" : "size-5", fill && "fill-current")} />
      {badge !== undefined && (
        <span aria-hidden className="absolute text-[0.5rem] font-semibold">
          {badge}
        </span>
      )}
    </Button>
  );
}
