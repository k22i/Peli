import { Slider } from "@base-ui/react/slider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCanGoBack, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  AlertCircle,
  AudioLines,
  Captions,
  ChevronLeft,
  Keyboard,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { NextEpisode } from "@/components/player/next-episode";
import { SeekBar } from "@/components/player/seek-bar";
import { ShortcutsOverlay } from "@/components/player/shortcuts";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { streamsQuery } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { countdownFrom, nextEpisode, type PreparedNext } from "@/lib/next-episode";
import { streamsPath, streamsSearch } from "@/lib/playback";
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
import { resolvePick } from "@/lib/resolve";
import {
  profileSettingsQuery,
  subtitleSizes,
  useSaveProfileSettings,
  type ProfileSettings,
} from "@/lib/settings";
import {
  autoSubtitle,
  byLanguage,
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
const sizeLabels: Record<string, string> = { small: "Small", medium: "Medium", large: "Large" };

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
// media controls (Go, media.go) name what plays from the heading.
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

  const [paused, setPaused] = useAhead(state.paused, same);
  const [position, setPosition] = useAhead(state.position, near);
  const [volume, setVolume] = useAhead(state.volume, near);
  const [muted, setMuted] = useAhead(state.muted, same);
  const [fullscreen, setFullscreen] = useAhead(state.fullscreen, same);
  const audioTracks = tracks.filter((track) => track.type === "audio");
  const subtitleTracks = tracks.filter((track) => track.type === "sub");
  const [audioId, setAudioId] = useAhead(selectedId(audioTracks), same);
  const [subtitleId, setSubtitleId] = useAhead(selectedId(subtitleTracks), same);
  const [subtitleDelay, setSubtitleDelay] = useAhead(
    state.subtitleDelay,
    (a, b) => Math.abs(a - b) < 0.001,
  );
  const [subtitleSize, setSubtitleSize] = useAhead(state.subtitleSize, same);
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [idle, wake] = useIdle(idleAfter);
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
  const from = countdownFrom(state.duration);
  const counting =
    next !== undefined && from !== undefined && state.position >= from && !cancelled && !error;
  // Play now, or the end: the card hands over what it found.
  const [starting, setStarting] = useState(false);
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
  const changeVolume = (to: number) => {
    setVolume(to);
    volumer(to);
    if (muted && to > 0) toggleMute();
  };
  const toggleMute = () => {
    setMuted(!muted);
    Player.SetMuted(!muted).catch(() => {});
  };
  const toggleFullscreen = () => {
    setFullscreen(!fullscreen);
    Player.SetFullscreen(!fullscreen).catch(() => {});
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
    setSubtitleId(id);
    Player.SetSubtitleTrack(id).catch(() => {});
    const track = subtitleTracks.find((each) => each.id === id);
    if (track && !track.forced) rememberLanguage(subtitleLanguage(track.lang).code);
  };
  // Adds an addon's subtitles, or shows them if they were added already.
  const addSubtitles = (subtitle: AddonSubtitle, picked: boolean) => {
    if (picked) {
      autoDone.current = true;
      rememberLanguage(subtitle.code);
    }
    const id = added.ids.get(subtitle.key);
    if (id) {
      setSubtitleId(id);
      Player.SetSubtitleTrack(id).catch(() => {});
      return;
    }
    const load = added.load;
    if (picked) setNotice({ text: "Loading subtitles…" });
    Player.AddSubtitle({ url: subtitle.url, lang: subtitle.code, title: subtitle.addon }).then(
      (newId) => {
        setAdded((current) =>
          current.load === load
            ? { load, ids: new Map(current.ids).set(subtitle.key, newId) }
            : current,
        );
        setSubtitleId(newId);
        if (picked) setNotice(undefined);
      },
      () => {
        if (picked) setNotice({ text: "Couldn’t load those subtitles" });
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
  useEffect(() => {
    if (tracks.length === 0) return;
    showingAddon.current = addonKey
      ? addonSubtitles.subtitles.find((subtitle) => subtitle.key === addonKey)
      : undefined;
  });
  const languageGroups = byLanguage(addonSubtitles.subtitles, settings?.subtitleLanguage ?? "");
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
    const to = Math.max(0, Math.min(100, Math.round(volume + by)));
    changeVolume(to);
    setNotice({ text: `Volume ${to} %` });
  };
  const sizeSubtitles = (size: string) => {
    setSubtitleSize(size);
    Player.SetSubtitleSize(size).catch(() => {});
    // The profile's size from now on, as in Settings.
    if (settings && settings.subtitleSize !== size)
      saveSettings.mutate({ ...settings, subtitleSize: size } satisfies ProfileSettings);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      wake();
      // An open menu has the keys: Esc closes it, Space picks.
      if (error || menuOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Not a click on the focused button too, as its key comes up.
      if (event.key === " ") event.preventDefault();
      if (event.type !== "keydown") return;
      // Keys held down repeat these; the rest act once a press.
      const repeating: Record<string, () => void> = {
        arrowleft: () => seek(position - skip),
        arrowright: () => seek(position + skip),
        arrowup: () => stepVolume(volumeStep),
        arrowdown: () => stepVolume(-volumeStep),
        z: () => ready && subtitleTracks.length > 0 && timeSubtitlesBy(-delayStep),
        x: () => ready && subtitleTracks.length > 0 && timeSubtitlesBy(delayStep),
      };
      const once: Record<string, () => void> = {
        " ": togglePause,
        k: togglePause,
        m: toggleMute,
        f: toggleFullscreen,
        c: () => ready && subtitleTracks.length > 0 && cycleSubtitles(),
        a: () => ready && audioTracks.length > 1 && cycleAudio(),
        "?": () => setHelpOpen(!helpOpen),
        escape: () => {
          if (helpOpen) setHelpOpen(false);
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
    !idle || paused || !ready || state.loading || dragging || over || menuOpen || helpOpen;
  const hold = { onPointerEnter: () => setOver(true), onPointerLeave: () => setOver(false) };
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <div
      className={cn("fixed inset-0 text-white select-none", !shown && "cursor-none")}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      {/* The video itself: a click pauses, a double click goes fullscreen.
          The Play button below is the one to reach by keyboard. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className={cn("absolute inset-0 outline-none", shown ? "cursor-default" : "cursor-none")}
        onClick={togglePause}
        onDoubleClick={toggleFullscreen}
      />
      <div
        data-testid="controls"
        data-shown={shown || undefined}
        className={cn(
          "transition-opacity duration-300",
          shown ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {/* Room for the macOS traffic lights, and a drag strip. */}
        <div
          {...hold}
          className="absolute inset-x-0 top-0 flex h-20 items-start gap-2 bg-linear-to-b from-black/70 to-transparent pt-3 pr-4 pl-20 drag-region"
        >
          <ControlButton label="Back" icon={ChevronLeft} onClick={leave} />
          <div className="flex min-w-0 flex-col pt-1">
            {playing?.title && <h1 className="truncate text-sm font-semibold">{playing.title}</h1>}
            {playing?.episode && (
              <p className="truncate text-xs text-white/70">{playing.episode}</p>
            )}
          </div>
          {torrentStatus?.active && (
            <p
              aria-label="Torrent status"
              className="ms-auto shrink-0 pt-1.5 font-mono text-xs text-white/70 tabular-nums"
            >
              {torrentStatusText(torrentStatus)}
            </p>
          )}
        </div>
        <div
          {...hold}
          className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-linear-to-t from-black/80 via-black/40 to-transparent px-6 pt-16 pb-4"
        >
          <SeekBar
            position={position}
            duration={state.duration}
            buffered={state.buffered}
            playing={!paused && ready}
            onScrub={(to) => ready && seeker({ to, exact: false })}
            onSeek={seek}
            onDraggingChange={setDragging}
          />
          <div className="flex items-center gap-1">
            <ControlButton
              label={paused ? "Play" : "Pause"}
              icon={paused ? Play : Pause}
              onClick={togglePause}
              aria-keyshortcuts="Space K"
              disabled={!ready}
              fill
            />
            <ControlButton
              label="Back 10 seconds"
              icon={RotateCcw}
              aria-keyshortcuts="ArrowLeft"
              onClick={() => seek(position - skip)}
              disabled={!ready || !known}
              badge={skip}
            />
            <ControlButton
              label="Forward 10 seconds"
              icon={RotateCw}
              aria-keyshortcuts="ArrowRight"
              onClick={() => seek(position + skip)}
              disabled={!ready || !known}
              badge={skip}
            />
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
                max={100}
                onValueChange={changeVolume}
                className="w-0 overflow-hidden opacity-0 transition-[width,opacity] duration-200 group-focus-within/volume:w-24 group-focus-within/volume:opacity-100 group-hover/volume:w-24 group-hover/volume:opacity-100"
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
            {known && (
              <p className="ms-2 font-mono text-xs text-white/80 tabular-nums">
                {formatTime(position)} / {formatTime(state.duration)}
              </p>
            )}
            <div className="ms-auto flex items-center gap-1">
              {ready && audioTracks.length > 1 && (
                <Menu onOpenChange={setMenuOpen}>
                  <MenuTrigger render={<ControlButton label="Audio" icon={AudioLines} />} />
                  <PlayerMenuPopup>
                    <MenuGroup>
                      <MenuGroupLabel>Audio</MenuGroupLabel>
                      <MenuRadioGroup value={audioId} onValueChange={(id: number) => pickAudio(id)}>
                        {audioTracks.map((track) => (
                          <TrackItem key={track.id} track={track} />
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </PlayerMenuPopup>
                </Menu>
              )}
              {ready && subtitlesMenu && (
                <Menu onOpenChange={setMenuOpen}>
                  <MenuTrigger render={<ControlButton label="Subtitles" icon={Captions} />} />
                  <PlayerMenuPopup>
                    <MenuGroup>
                      <MenuGroupLabel>Subtitles</MenuGroupLabel>
                      <MenuRadioGroup
                        value={subtitleId}
                        onValueChange={(id: number) => pickSubtitles(id)}
                      >
                        <MenuRadioItem value={0}>Off</MenuRadioItem>
                        {subtitleTracks.map((track) => (
                          <TrackItem key={track.id} track={track} />
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                    {(languageGroups.length > 0 || addonSubtitles.loading) && (
                      <>
                        <MenuSeparator />
                        <MenuGroup>
                          <MenuGroupLabel>From addons</MenuGroupLabel>
                          {languageGroups.map((group) => (
                            <MenuSub key={group.language}>
                              <MenuSubTrigger>
                                <span className="truncate">{group.label}</span>
                                <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                                  {group.subtitles.length}
                                </span>
                              </MenuSubTrigger>
                              <MenuSubPopup className="dark max-w-80 text-foreground">
                                <MenuRadioGroup
                                  value={addonKey ?? ""}
                                  onValueChange={(key: string) => {
                                    const subtitle = group.subtitles.find(
                                      (each) => each.key === key,
                                    );
                                    if (subtitle) addSubtitles(subtitle, true);
                                  }}
                                >
                                  {group.subtitles.map((subtitle, index) => (
                                    <AddonSubtitleItem
                                      key={subtitle.key}
                                      subtitle={subtitle}
                                      number={index + 1}
                                    />
                                  ))}
                                </MenuRadioGroup>
                              </MenuSubPopup>
                            </MenuSub>
                          ))}
                          {addonSubtitles.loading && (
                            <MenuItem disabled>
                              <Spinner />
                              Asking addons…
                            </MenuItem>
                          )}
                        </MenuGroup>
                      </>
                    )}
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Size</MenuGroupLabel>
                      <MenuRadioGroup
                        value={subtitleSize}
                        onValueChange={(size: string) => sizeSubtitles(size)}
                      >
                        {subtitleSizes.map((size) => (
                          <MenuRadioItem key={size} value={size}>
                            {sizeLabels[size]}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Timing: {subtitleDelayText(subtitleDelay)}</MenuGroupLabel>
                      <MenuItem
                        closeOnClick={false}
                        onClick={() => timeSubtitles(subtitleDelay - delayStep)}
                      >
                        Earlier
                        <MenuShortcut aria-hidden>Z</MenuShortcut>
                      </MenuItem>
                      <MenuItem
                        closeOnClick={false}
                        onClick={() => timeSubtitles(subtitleDelay + delayStep)}
                      >
                        Later
                        <MenuShortcut aria-hidden>X</MenuShortcut>
                      </MenuItem>
                      <MenuItem
                        closeOnClick={false}
                        disabled={subtitleDelay === 0}
                        onClick={() => timeSubtitles(0)}
                      >
                        Reset timing
                      </MenuItem>
                    </MenuGroup>
                  </PlayerMenuPopup>
                </Menu>
              )}
              <ControlButton
                label="Keyboard shortcuts"
                icon={Keyboard}
                onClick={() => setHelpOpen(!helpOpen)}
                aria-keyshortcuts="Shift+?"
                aria-expanded={helpOpen}
              />
              <ControlButton
                label={fullscreen ? "Exit full screen" : "Full screen"}
                icon={fullscreen ? Minimize : Maximize}
                onClick={toggleFullscreen}
                aria-keyshortcuts="F"
              />
            </div>
          </div>
        </div>
      </div>
      {offerStartOver && !failure && (
        <div
          {...hold}
          className="absolute bottom-28 left-6 flex items-center gap-3 rounded-full bg-black/70 py-1.5 ps-4 pe-1.5 text-sm"
        >
          <p className="font-medium">
            Resumed at <span className="tabular-nums">{formatTime(resumedAt)}</span>
          </p>
          <Button size="sm" variant="secondary" className="rounded-full" onClick={startOver}>
            <RotateCcw />
            Start over
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
          onPlay={() => setStarting(true)}
          onCancel={() => setCancelled(true)}
          onStart={(prepared) => void playNext(prepared)}
        />
      )}
      {helpOpen && !failure && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}
      {notice && !failure && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 top-20 flex justify-center"
        >
          <p className="rounded-full bg-black/70 px-4 py-1.5 text-sm font-medium">{notice.text}</p>
        </div>
      )}
      {failure ? (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-black/75">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <AlertCircle className="size-8 text-white/70" />
            <p className="text-lg font-semibold">{failure.title}</p>
            <p className="text-sm text-white/70">{failure.description}</p>
            <div className="mt-2 flex gap-2">
              {failure.retry && playing?.source && (
                <Button onClick={() => void retry(error)} disabled={retrying}>
                  {retrying && <Spinner />}
                  Try again
                </Button>
              )}
              <Button variant="secondary" onClick={leave} disabled={retrying}>
                Choose another stream
              </Button>
            </div>
          </div>
        </div>
      ) : (
        waiting && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-2">
              <Spinner className="size-10 text-white/80" />
              {starting && next && (
                <p className="text-sm font-medium text-white/80">Opening {episodeCode(next)}…</p>
              )}
              {!starting && state.buffering && state.bufferPercent > 0 && (
                <p className="font-mono text-xs text-white/70 tabular-nums">
                  Buffering {state.bufferPercent} %
                </p>
              )}
              {!starting && torrentStatus?.active && (
                <p className="font-mono text-xs text-white/70 tabular-nums">
                  {torrentStatusText(torrentStatus)}
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

// The player's menus are dark over any theme, like the rest of its chrome,
// and open above the controls.
function PlayerMenuPopup({ children }: { children: ReactNode }) {
  return (
    <MenuPopup side="top" align="end" sideOffset={8} className="dark max-w-80 text-foreground">
      {children}
    </MenuPopup>
  );
}

function TrackItem({ track }: { track: Track }) {
  const { name, detail } = trackLabel(track);
  return (
    <MenuRadioItem value={track.id}>
      <span className="flex flex-col">
        <span className="truncate">{name}</span>{" "}
        {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
    </MenuRadioItem>
  );
}

// One addon's file: its name, or "English 2" when it has none, and the addon.
function AddonSubtitleItem({ subtitle, number }: { subtitle: AddonSubtitle; number: number }) {
  return (
    <MenuRadioItem value={subtitle.key}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{subtitle.name || `Subtitles ${number}`}</span>{" "}
        <span className="truncate text-xs text-muted-foreground">{subtitle.addon}</span>
      </span>
    </MenuRadioItem>
  );
}

function ControlButton({
  label,
  icon: Icon,
  fill,
  badge,
  ...props
}: {
  label: string;
  icon: LucideIcon;
  fill?: boolean;
  badge?: ReactNode;
} & Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      className="relative rounded-full text-white hover:bg-white/15 hover:text-white data-popup-open:bg-white/15"
      {...props}
    >
      <Icon className={cn("size-5", fill && "fill-current")} />
      {badge !== undefined && (
        <span aria-hidden className="absolute text-[0.5rem] font-semibold">
          {badge}
        </span>
      )}
    </Button>
  );
}
