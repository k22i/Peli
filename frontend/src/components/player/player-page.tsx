import { Slider } from "@base-ui/react/slider";
import { Events } from "@wailsio/runtime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCanGoBack, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  History as Resumed,
  AlertCircle,
  AudioLines,
  Captions,
  ChevronLeft,
  Keyboard,
  Layers,
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
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type RefObject,
  type ReactNode,
} from "react";

import { Service as Diagnostics } from "@bindings/diagnostics";
import { Connection } from "@bindings/syncer";
import { PartyDock, partyDockWidth, usePartyDock } from "@/components/party/party-dock";
import { PartyPill, PartySheet } from "@/components/party/party-sheet";
import { PartyReactionLayer, ReactionBar } from "@/components/party/reaction-bar";
import { MoreMenu } from "@/components/player/more-menu";
import { NextEpisode } from "@/components/player/next-episode";
import { PictureSheet, type PictureSheetTab } from "@/components/player/picture-sheet";
import { Prompt, promptEnter } from "@/components/player/prompt";
import { SeekBar } from "@/components/player/seek-bar";
import { SecondSubtitles } from "@/components/player/second-subtitles";
import { ShortcutsOverlay } from "@/components/player/shortcuts";
import { PlayerEndsAt } from "@/components/player/ends-at";
import { SpeedMenu } from "@/components/player/speed-menu";
import {
  EpisodesSheet,
  GlassButton,
  HoldPill,
  LevelHud,
  LockPill,
  RowButton,
  ScrubLabel,
  SkipRipple,
  TouchMoreMenu,
  TouchSpeedMenu,
  TouchTopRow,
  TracksSheet,
  touchChromeRem,
} from "@/components/player/touch-chrome";
import { StatsOverlay } from "@/components/player/stats-overlay";
import { StillWatching } from "@/components/player/still-watching";
import { StreamSwitcher, type Refresh } from "@/components/player/stream-switcher";
import {
  defaultSubtitleStyle,
  SubtitlePanel,
  type PanelTab,
  type SubtitleStyle,
} from "@/components/player/subtitle-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { loopArgs, loopOf, nextLoop, sameLoop, type Loop } from "@/lib/ab-loop";
import { streamsQuery, type Stream } from "@/lib/addon-protocol";
import { chapterAt, chapterName, nextChapter, previousChapter } from "@/lib/chapters";
import { haptic } from "@/lib/haptics";
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
  type PartyInfo,
  partyMedia,
  sharedStream,
  useParty,
  usePartyChat,
  usePartyNotices,
  useWatchWithParty,
} from "@/lib/party";
import { playableQuery, type Playable } from "@/lib/downloads";
import { isDownloadSource, loadDownloaded, streamsPath, streamsSearch } from "@/lib/playback";
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
import { keepWindowClear, repaintWindow } from "@/lib/theme";
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
import { attempts, PlayError, resolvePick, sameStream, type Attempt } from "@/lib/resolve";
import { isPartyGuest, usePartyAutoPick, type PartyPicked } from "@/lib/party-pick";
import type { Watching } from "@bindings/playback";
import type { Source } from "@bindings/streams";
import type { Source as PartySource } from "@bindings/party";
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
import {
  fadeFor,
  fadedVolume,
  sleepChoiceOf,
  sleepChoices,
  sleepHint,
  sleepLeft,
  sleepOff,
  sleepTimerFor,
  type SleepTimer,
} from "@/lib/sleep-timer";
import { normalSpeed, speedLabel, stepSpeed } from "@/lib/speed";
import { stillWatchingDue, useEpisodesWithoutInput } from "@/lib/still-watching";
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
  smartSubtitle,
  subtitleLanguage,
  subtitleTarget,
  useAddonSubtitles,
  wantedSubtitleLanguage,
  type AddonSubtitle,
} from "@/lib/subtitles";
import { invalidateWatching, useConnection } from "@/lib/sync";
import {
  cachedTitleMeta,
  episodeCode,
  episodeTarget,
  episodes as episodesOf,
  isSeriesType,
  playerHeading,
  resumePoint,
  titleMetaQuery,
  titleProgressQuery,
  watchingFor,
  type Episode,
} from "@/lib/title";
import { feature, useFeature } from "@/lib/features";
import { useHardwareKeyboard, usePointerAttached } from "@/lib/input-devices";
import {
  holdAfter,
  idle as gestureIdle,
  reduce as reduceGesture,
  type GestureEvent,
  type GestureOutput,
  type GestureState,
  type Side as LevelSide,
} from "@/lib/player-gestures";
import { isIOS, isTouch } from "@/lib/platform";
import { useCompactShell } from "@/lib/shell-mode";
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
    title: "Peli can’t play this file",
    description: "Its format isn’t one Peli’s player reads. Choose another stream.",
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
// A computed length in CSS pixels, 0 when there is none.
const px = (v: string | undefined) => Number.parseFloat(v ?? "") || 0;
// One press of Z or X moves subtitles this many seconds, as in mpv.
const delayStep = 0.1;
// The keys the iOS player leaves alone (#138): their controls are the
// desktop's only (ErrDesktopOnly in internal/player/service_ios.go, or a
// feature that's off on iOS). shortcuts.tsx leaves them out of the list. W
// (the watch party) is not one of them any more: parties are in the iOS app
// (ADR-0063), so an iPad with a keyboard opens the same sheet.
const iosKeysOff: ReadonlySet<string> = new Set([
  "f",
  "i",
  "s",
  "p",
  "b",
  "l",
  ",",
  ".",
  "=",
  "+",
  "-",
  "0",
]);
const iosShiftedOff: ReadonlySet<string> = new Set(["F", "A", "S"]);

// One press of ↑ or ↓ moves the volume this much, of 100.
const volumeStep = 5;
// How long "Start over" is offered once a resumed file plays.
const startOverFor = 10_000;
// How long the play/pause mark at the centre takes to fade out.
const flashFor = 450;
// How long the subtitles stay where a nudge put them, to show it, before
// they rise for the controls again.
const nudgeShown = 2500;
// The party's reactions (ADR-0051) take a row of the controls while it runs:
// above the seek bar, in the dock or in the touch chrome. In rem, here and at
// the root's --party-row, so the cards, the prompts and the subtitle lift all
// move up by it.
const reactionRowRem = 2.75;
// What subtitle-position calls the full dock's clearance, in rem: where the
// controls' top edge is. The reactions row is one more than that.
const dockClearanceRem = 8;

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
  // iOS: the video is a native view under the webview, so the window stays
  // clear while this screen is up (the cleanup below paints it again).
  useEffect(() => (isIOS() ? keepWindowClear() : undefined), []);
  // Leaving the screen, however it happens, ends the session, and lets the
  // torrent go once mpv no longer reads it. Go has kept where it stopped by
  // the time Stop returns, so the screens behind show it.
  useEffect(
    () => () => {
      const streamed = isTorrentSource(playingSource.current);
      // A watch party (ADR-0051) sees this member stop watching; the next
      // episode or another stream, as a new file of the screen, doesn't.
      if (feature("party")) Party.Watch(null, null).catch(() => {});
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
  // Episodes that started by themselves since the last key or pointer
  // input ("Still watching?"), and the sleep timer: both outlive a file.
  const streak = useEpisodesWithoutInput();
  const [sleep, setSleep] = useState<SleepTimer>(sleepOff);
  // One file at a time: the next episode starts afresh.
  return (
    <PlayerFile
      key={playing?.source?.url ?? ""}
      streak={streak}
      sleep={sleep}
      onSleepChange={setSleep}
    />
  );
}

function PlayerFile({
  streak,
  sleep,
  onSleepChange,
}: {
  streak: RefObject<number>;
  sleep: SleepTimer;
  onSleepChange: (timer: SleepTimer) => void;
}) {
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
  // This device's settings: how hard the renderer works, its output, and its
  // subtitles when they're always on.
  const device = useQuery(deviceSettingsQuery).data;
  const saveDevice = useSaveDeviceSettings();
  // The tracks last playing: mpv empties the list when a file fails, and
  // trying it again should keep what the user picked.
  const lastTracks = useRef<Track[]>([]);
  useEffect(() => {
    if (state.tracks?.length) lastTracks.current = state.tracks;
  }, [state.tracks]);
  const tracks = state.tracks ?? [];
  const target = useLocation({ select: (location) => location.state.player?.subtitles });
  // A downloaded file (ADR-0064) is its own: its saved subtitles are the
  // only ones, read from disk, and no addon is asked for more. They take the
  // addon subtitles' place in the menus, the automatic one and the re-add
  // after a reload.
  const downloaded = isDownloadSource(playing?.source);
  const saved = useQuery({
    ...playableQuery(profileId, watching?.videoId ?? ""),
    enabled: downloaded && profileId > 0 && watching !== undefined,
  });
  const found = useAddonSubtitles(profileId, downloaded ? undefined : target);
  const savedSubtitles = useMemo<AddonSubtitle[]>(
    () =>
      (saved.data?.subtitles ?? []).map((subtitle, index) => {
        const { language, code } = subtitleLanguage(subtitle.lang);
        return {
          key: `download ${index}`,
          url: subtitle.url,
          language,
          code,
          name: subtitle.title,
          addon: "Downloaded",
        };
      }),
    [saved.data],
  );
  const addonSubtitles = downloaded
    ? { subtitles: savedSubtitles, loading: saved.isLoading }
    : found;
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
  const [loop, setLoop] = useAhead(loopOf(state), sameLoop);
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // The stream being opened from the switcher, or why it couldn't be.
  const [switchStatus, setSwitchStatus] = useState<{ text: string; failed?: string }>();
  // The host's new stream this guest follows (ADR-0051), until it plays.
  const [following, setFollowing] = useState<PartySource>();
  const pickAbort = useRef<AbortController>(null);
  useEffect(() => () => pickAbort.current?.abort(), []);
  const [idle, wake, hideControls] = useIdle(idleAfter);
  // The last pointer down on the picture: "mouse" for an iPad's trackpad.
  const surfacePointer = useRef("");
  // A finger: tap shows or hides the controls, a double tap on a side skips
  // 10 s, and the dock is two rows (iOS).
  const touch = isTouch();
  const touchLayout = touch && !mini;
  // The desktop shortcuts and their list: an iPad's while a hardware
  // keyboard is attached (#138).
  const desktopControls = useFeature("desktopControls");
  const keyboard = useHardwareKeyboard();
  const pointerAttached = usePointerAttached();
  const compactWindow = useCompactShell();
  // An iPad window at regular width (#138): #130's chrome with more room.
  // The touch player's own chrome (#130): the top row, the transport in the
  // middle, a thin seek row and a row of text buttons for a series. The mini
  // player keeps its card.
  const [episodesOpen, setEpisodesOpen] = useState(false);
  // A scrub in progress: where it started and where it's going. The seek
  // bar's drag drives it, and #131's horizontal swipe will through
  // scrubTo/endScrub; everything but the seek row fades meanwhile.
  const [scrub, setScrub] = useState<{ from: number; to: number }>();
  // The touch player's gestures (#131): how far a double tap and the skip
  // buttons go (Settings › Playback › Gestures), and the Lock, which hides
  // every control and turns the gestures off until its pill is held.
  const gestureSettings = touchLayout ? settings?.gestures : undefined;
  const skipBy = gestureSettings?.doubleTapSkip ?? skip;
  const [locked, setLocked] = useState(false);
  const [lockPill, setLockPill] = useState(false);
  useEffect(() => {
    if (!lockPill) return undefined;
    const timer = setTimeout(() => setLockPill(false), 2000);
    return () => clearTimeout(timer);
  }, [lockPill]);
  // A run of double-tap skips on one side, sent as one seek 400 ms after
  // the last tap, and its ripple.
  const [ripple, setRipple] = useState<{ side: -1 | 1; total: number }>();
  const skipRun = useRef<{
    side: -1 | 1;
    total: number;
    sent: number;
    at: number;
    seekTimer?: ReturnType<typeof setTimeout>;
    hideTimer?: ReturnType<typeof setTimeout>;
  }>(undefined);
  useEffect(
    () => () => {
      clearTimeout(skipRun.current?.seekTimer);
      clearTimeout(skipRun.current?.hideTimer);
    },
    [],
  );
  const lastTap = useRef<{ at: number; side: number; timer: ReturnType<typeof setTimeout> }>(
    undefined,
  );
  const surface = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(lastTap.current?.timer), []);
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
  // The bottom row always shows there (Speed moves into it from More), and
  // a volume slider joins it while a keyboard or a pointer is attached.
  const roomy = touchLayout && isIOS() && !compactWindow;
  const bottomRow = series !== undefined || roomy;
  const volumeSlider = roomy && (keyboard || pointerAttached);
  const meta = useQuery({
    ...titleMetaQuery(browsing.addons, series?.contentType ?? "", series?.contentId ?? ""),
    enabled: series !== undefined && !browsing.loading,
    ...(series &&
      cachedTitleMeta(queryClient, browsing.addons, series.contentType, series.contentId)),
  }).data?.meta;
  const afterThis = meta && series ? nextEpisode(meta, series.videoId) : undefined;
  // Offline, only a downloaded next episode is offered: with none there is
  // no card or countdown, and the file just ends.
  const offline = useConnection() === Connection.Offline;
  const afterThisSaved = useQuery({
    ...playableQuery(profileId, afterThis?.id ?? ""),
    enabled: offline && afterThis !== undefined && profileId > 0,
  });
  const next = offline && !afterThisSaved.data ? undefined : afterThis;
  const [cancelled, setCancelled] = useState(false);
  // A downloaded file's skip times are saved with it: IntroDB isn't asked.
  const onlineSegments = useOnlineSegments(
    watching,
    downloaded ? (saved.data?.segments ?? []) : undefined,
  );
  const segments = skipSegments(state.chapters ?? [], onlineSegments, state.duration);
  const from = countdownFrom(
    state.duration,
    segments.find((segment) => segment.kind === "credits")?.start,
  );
  const counting =
    next !== undefined && from !== undefined && state.position >= from && !cancelled && !error;
  // Play now, or the end: the card hands over what it found.
  const [starting, setStarting] = useState(false);
  // "Still watching?", with how many episodes played in a row.
  const [asking, setAsking] = useState<number>();

  // A watch party (ADR-0051): Go follows the player and keeps it in step;
  // this screen says what it plays (as the party names it), opens the party
  // sheet (W), shows the party's line at the top, and offers to follow the
  // party when it watches something else.
  const partyState = useParty();
  const party = partyState?.party ?? undefined;
  // The party's reactions sit in the chrome, a row above the seek bar, while a
  // party runs and the picture has room for it: the mini player keeps its few
  // controls as they are.
  const reactionRow = party !== undefined && !mini;
  const partyChat = usePartyChat();
  const [partyOpen, setPartyOpen] = useState(false);
  // "Keep open": the party panel is a sidebar the picture makes room for,
  // not a sheet over it. The mini player hides it without changing either.
  const { docked } = usePartyDock();
  const dockShown = docked && partyOpen && !mini;
  const dockRef = useRef<HTMLDivElement>(null);
  const dockStyle: CSSProperties & Record<`--${string}`, string> = {
    "--party-dock-w": dockShown ? partyDockWidth : "0px",
  };
  const media = watching ? partyMedia(watching, heading, meta, playing?.stream) : undefined;
  // A guest doesn't choose a stream (ADR-0051): the party picks one from the
  // host's for them, so the switcher, S and the failure overlay's way out are
  // the host's alone. The host keeps them as they were.
  const guest = isPartyGuest(party, media);
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
    if (media && feature("party")) Party.Watch(media, shared ?? null).catch(() => {});
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
    // A guest follows the host onto another stream (the prompt shows it).
    if (said.kind === "source") {
      if (said.media?.source && isPartyGuest(party, media)) setFollowing(said.media.source);
      return;
    }
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
  // The party's next episode, when this device is its guest: nothing here
  // gets that episode's streams ready, since a guest never picks (ADR-0051).
  // Playing it (Play it, Play now, the end of the file) opens the party's
  // picker, which picks from the host's stream and starts where the party is.
  // The guest test is the party's own (`!party.isHost`), not `guest` above:
  // that one asks whether the party is on the file playing, and here it is on
  // the next one instead.
  const partyNext = partyIsNext && !party?.isHost ? partyElsewhere : undefined;
  const startNext = () => {
    if (partyNext) return watchWithParty(partyNext, true);
    setStarting(true);
  };
  // While the next episode opens, the file ending or failing is expected.
  const switching = useRef(false);
  const switchAbort = useRef<AbortController>(null);
  useEffect(() => () => switchAbort.current?.abort(), []);

  usePlayerEnded((ended) => {
    if (switching.current) return;
    if (ended.reason === "eof") {
      // The sleep timer missed the end it was waiting for: stop here.
      if (sleep.kind === "episode") {
        onSleepChange(sleepOff);
        return leave();
      }
      if (counting) {
        // Enough episodes in a row with nobody touching anything: ask.
        if (stillWatchingDue(settings?.stillWatchingAfter, streak.current)) {
          return setAsking(streak.current + 1);
        }
        streak.current += 1;
        return startNext();
      }
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
      !isDownloadSource(expired) &&
      Date.now() - reloadedAt.current > 60_000
    ) {
      reloadedAt.current = Date.now();
      reloadExpired(
        expired,
        loadOptions(state.position, settings, lastTracks.current, watching, device),
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
      const options = loadOptions(
        stoppedAt.current,
        settings,
        lastTracks.current,
        watching,
        device,
      );
      if (ended.code === "expired" && !isTorrentSource(current) && !isDownloadSource(current))
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
  const dockMenuOpen = (speedOpen || moreOpen) && ready && !mini;
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
  // Another episode, from the Episodes sheet: through the stream picker,
  // in place of this screen, as the next one goes when nothing was ready.
  const chooseEpisode = (episode: Episode) => {
    if (!meta) return;
    setEpisodesOpen(false);
    const picked = episodeTarget(meta, episode);
    void navigate({
      to: streamsPath,
      params: { type: picked.type, id: picked.id },
      search: streamsSearch({ video: picked.videoId }),
      state: (current) => ({ ...current, play: picked }),
      replace: true,
    });
  };
  // Plays the next episode in this session: its progress kept as its own,
  // from where it was left, in the languages playing now.
  const playNext = async (prepared: PreparedNext) => {
    if (!meta || !next || (prepared.status !== "ready" && prepared.status !== "downloaded"))
      return chooseNext();
    const controller = new AbortController();
    switchAbort.current = controller;
    switching.current = true;
    const nextTarget = episodeTarget(meta, next);
    try {
      if (prepared.status === "downloaded") {
        // A downloaded episode: its file, nothing resolved (ADR-0064).
        const player = await loadDownloaded({
          client: queryClient,
          profileId,
          target: nextTarget,
          playable: prepared.playable,
          meta,
          settings,
          tracks: lastTracks.current,
        });
        controller.signal.throwIfAborted();
        // A torrent playing that the next episode doesn't come from.
        if (isTorrentSource(source.current)) Torrents.Release().catch(() => {});
        void navigate({
          to: "/player",
          replace: true,
          state: (current) => ({ ...current, player }),
        });
        return;
      }
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
      await Player.Load(
        nextSource,
        loadOptions(start, settings, lastTracks.current, nextWatching, device),
      );
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
  // Loads a resolved stream into this session at `at` and brings the screen
  // to it: the end of a switch, whoever chose it. `remember` is only the
  // user's own choice; a party's pick never is (ADR-0051). False when the
  // player couldn't open it.
  const loadSwitch = async ({
    picked,
    attempt,
    addon,
    at,
    remember,
  }: {
    picked: Source;
    attempt: Attempt;
    addon: string;
    at: number;
    remember?: Candidate;
  }): Promise<boolean> => {
    if (!watching) return false;
    switching.current = true;
    try {
      await Player.Load(picked, loadOptions(at, settings, lastTracks.current, watching, device));
    } catch {
      switching.current = false;
      return false;
    }
    if (remember) {
      rememberSource(
        queryClient,
        watching.profileId,
        watching.contentType,
        watching.contentId,
        remember,
        attempt,
      );
    }
    // A torrent playing that the new stream doesn't come from.
    if (isTorrentSource(source.current) && !isTorrentSource(picked))
      Torrents.Release().catch(() => {});
    const subtitles = subtitleTarget(watching.contentType, watching.videoId, attempt.stream, addon);
    if (picked.url === source.current?.url) {
      // The same link: this screen plays it on.
      switching.current = false;
      source.current = picked;
      reloaded();
      setError(undefined);
      setSwitchStatus(undefined);
      setSwitcherOpen(false);
      return true;
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
    return true;
  };
  // The host switched streams (ADR-0051): the chooser's pick plays from
  // where this guest is, not the party. Only the latest pick loads, and
  // the guest's remembered source stays theirs.
  const followAbort = useRef<AbortController>(null);
  useEffect(() => () => followAbort.current?.abort(), []);
  const followPick = async (picked: PartyPicked, onFail: () => void) => {
    if (picked.same || !picked.source) return setFollowing(undefined);
    followAbort.current?.abort();
    const controller = new AbortController();
    followAbort.current = controller;
    try {
      const at = error ? stoppedAt.current : (await Player.Snapshot()).position;
      if (controller.signal.aborted) return;
      const loaded = await loadSwitch({
        picked: picked.source,
        attempt: picked.attempt,
        addon: "",
        at,
      });
      if (controller.signal.aborted) return;
      if (loaded) setFollowing(undefined);
      else onFail();
    } catch {
      if (!controller.signal.aborted) onFail();
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
      const loaded = await loadSwitch({
        picked,
        attempt,
        addon: names.get(attempt.source) ?? "",
        at,
        // The user's choice is the show's source from now on (#58).
        remember: candidate,
      });
      if (!loaded) {
        return setSwitchStatus({
          text: "",
          failed: "Peli’s player couldn’t start it. Try another stream.",
        });
      }
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
  // The downloaded copy (ADR-0064), from where this one is: loaded as a
  // switch is, with the same progress kept, in the languages playing now.
  // Nothing is resolved, so it works offline.
  const switchToDownload = async (playable: Playable) => {
    if (!watching) return;
    if (!error && isDownloadSource(playing?.source)) return setSwitcherOpen(false);
    pickAbort.current?.abort();
    setSwitchStatus({ text: "Opening the downloaded copy…" });
    try {
      const at = error ? stoppedAt.current : (await Player.Snapshot()).position;
      switching.current = true;
      try {
        await Player.Load(
          playable.source,
          loadOptions(at, settings, lastTracks.current, watching, device),
        );
      } catch {
        switching.current = false;
        return setSwitchStatus({
          text: "",
          failed: "Peli’s player couldn’t start it. Try another stream.",
        });
      }
      // A torrent playing that the download doesn't come from.
      if (isTorrentSource(source.current)) Torrents.Release().catch(() => {});
      void navigate({
        to: "/player",
        replace: true,
        state: (history) => {
          // Not an addon's stream: nothing to mark playing or ask subtitles of.
          const { stream, subtitles, ...kept } = history.player ?? { title: "" };
          void stream;
          void subtitles;
          return {
            ...history,
            player: { ...kept, source: playable.source, resumedAt: 0 },
          };
        },
      });
    } catch {
      switching.current = false;
      setSwitchStatus({ text: "", failed: "Peli’s player couldn’t start it." });
    }
  };
  // The switcher needs the app window: the mini player leaves for it. A guest
  // in a watch party has no stream to choose, so nothing opens it for them.
  const openSwitcher = () => {
    if (guest) return;
    if (mini) {
      setMini(false);
      Player.SetMini(false).catch(() => {});
    }
    setSwitchStatus(undefined);
    setSwitcherOpen(true);
  };
  // The failure overlay's way to another stream: a guest's is the party's
  // picker, which picks one from the host's stream for them (lib/party-pick);
  // the host's is the switcher, or leaving when there is nothing to switch.
  const anotherStream = () => {
    if (guest && party) return watchWithParty(party.media, true);
    if (watching && feature("streamSwitcher")) return openSwitcher();
    leave();
  };
  const openParty = () => {
    if (mini) {
      setMini(false);
      Player.SetMini(false).catch(() => {});
    }
    setHelpOpen(false);
    // Leaving the mini player brings a docked party back, not away.
    setPartyOpen(mini && docked ? true : !partyOpen);
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
  // A scrub: the picture follows (keyframe seeks), and the end lands exactly.
  const scrubTo = (to: number) => {
    if (!ready || !known) return;
    const at = Math.min(Math.max(0, to), state.duration);
    setScrub((current) => ({ from: current?.from ?? position, to: at }));
    seeker({ to: at, exact: false });
  };
  // #131's swipe ends its scrubs here too; a drag's release seeks itself.
  const endScrub = (commit = true) => {
    if (scrub && commit) seek(scrub.to);
    setScrub(undefined);
  };
  const startOver = () => {
    setStartOverDone(true);
    seek(0);
  };
  // The newest position and seek, for timers that fire after a render.
  const positionRef = useRef(position);
  positionRef.current = position;
  const seekRef = useRef(seek);
  seekRef.current = seek;
  // One more double-tap skip on side: a new run, or one more step of the
  // run on that side (YouTube's "20 seconds", "30 seconds").
  const addSkip = (side: -1 | 1) => {
    const now = Date.now();
    let run = skipRun.current;
    if (!run || run.side !== side || now - run.at > 600) {
      clearTimeout(run?.seekTimer);
      clearTimeout(run?.hideTimer);
      run = { side, total: 0, sent: 0, at: now };
      skipRun.current = run;
    }
    const current = run;
    current.total += skipBy;
    current.at = now;
    haptic("light");
    setRipple({ side, total: current.total });
    clearTimeout(current.seekTimer);
    clearTimeout(current.hideTimer);
    current.seekTimer = setTimeout(() => {
      const by = current.total - current.sent;
      current.sent = current.total;
      if (by) seekRef.current(positionRef.current + side * by);
    }, 400);
    current.hideTimer = setTimeout(() => {
      if (skipRun.current === current) skipRun.current = undefined;
      setRipple(undefined);
    }, 600);
  };
  // A tap on the picture, on touch: the second tap of a pair on the left or
  // right third skips that way (and on the touch chrome, each further tap
  // within 600 ms adds as much again); a pair in the middle plays or
  // pauses. A single tap (once no second one came) hides the controls when
  // they show, and shows them when they don't.
  const tapPicture = (x: number, box: DOMRect) => {
    const side = x < box.left + box.width / 3 ? -1 : x > box.right - box.width / 3 ? 1 : 0;
    const run = skipRun.current;
    if (touchLayout && run && side === run.side && Date.now() - run.at < 600) {
      clearTimeout(lastTap.current?.timer);
      lastTap.current = undefined;
      addSkip(side);
      return;
    }
    const last = lastTap.current;
    if (last && last.side === side && Date.now() - last.at < 300) {
      clearTimeout(last.timer);
      lastTap.current = undefined;
      if (side === 0) {
        togglePause();
        return;
      }
      if (touchLayout) {
        addSkip(side);
        return;
      }
      seek(position + side * skip);
      setNotice({ text: side < 0 ? "−10 s" : "+10 s" });
      return;
    }
    clearTimeout(last?.timer);
    lastTap.current = {
      at: Date.now(),
      side,
      timer: setTimeout(() => {
        lastTap.current = undefined;
        if (shownRef.current) hideControls();
        else wake();
      }, 280),
    };
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
  // , and . step a frame back or on (Go), and leave it paused: a file that
  // plays pauses first. In a watch party it's a pause and a seek.
  const stepFrame = (back: boolean) => {
    if (!ready || !known || state.loading) return;
    if (!paused) setPaused(true);
    Player.FrameStep(back).catch(() => {});
  };
  // The A–B loop (L, More): set A, set B, clear. Not while a watch party
  // watches this too: Go's gate would refuse it.
  const changeLoop = (to: Loop, text: string) => {
    if (!ready || !known) return;
    if (party?.watching && to.a !== undefined) {
      return setNotice({ text: "A–B loops are off in a watch party" });
    }
    setLoop(to);
    Player.SetLoop(...loopArgs(to)).catch(() => {});
    setNotice({ text });
  };
  const stepLoop = () => {
    const step = nextLoop(loop, position);
    changeLoop(step.loop, step.text);
  };
  // Page Up and Page Down, and More › Chapters: seeks to a chapter's start.
  const chapters = state.chapters ?? [];
  const goToChapter = (to: ReturnType<typeof nextChapter>) => {
    if (!to || !ready || !known) return;
    seek(to.chapter.time);
    setNotice({ text: `${to.index + 1}. ${chapterName(to.chapter, to.index)}` });
  };
  // Shift+S, or More: the frame as a PNG in ~/Pictures/Peli (Go), with
  // the subtitles showing or without them, and a toast to find it.
  const takeScreenshot = (subtitles: boolean) => {
    if (!ready || state.loading) return;
    Player.Screenshot(subtitles).then(
      (path) =>
        toastManager.add({
          type: "success",
          title: "Screenshot saved",
          description: path.split(/[\\/]/).pop(),
          actionProps: {
            children: fileManager,
            onClick: () => void Player.ShowScreenshot(path).catch(() => {}),
          },
        }),
      () => toastManager.add({ type: "error", title: "Couldn’t take a screenshot" }),
    );
  };
  // The sleep timer (More): the volume fades over its last seconds, then
  // playback pauses and the volume comes back for the next play.
  const fileKey = playing?.source?.url ?? "";
  useEffect(() => {
    // The end of an episode means the one it was set in.
    if (sleep.kind === "episode" && sleep.file !== fileKey) onSleepChange(sleepOff);
    // oxlint-disable-next-line react/exhaustive-deps -- once per file
  }, []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (sleep.kind !== "minutes") return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [sleep]);
  const sleepFor = sleepLeft(sleep, now, {
    position,
    duration: state.duration,
    speed: state.speed,
  });
  const fadeFrom = useRef<number>(undefined);
  const unfade = () => {
    if (fadeFrom.current === undefined) return;
    volumer(fadeFrom.current);
    fadeFrom.current = undefined;
  };
  const sleepTick = useEffectEvent((left: number | undefined) => {
    if (left === undefined || !ready) return unfade();
    if (left <= 0) {
      onSleepChange(sleepOff);
      if (!paused) {
        setPaused(true);
        Player.SetPaused(true).catch(() => {});
      }
      unfade();
      setNotice({ text: "The sleep timer paused playback" });
      return;
    }
    if (left > fadeFor || paused || muted) return unfade();
    fadeFrom.current ??= volume;
    volumer(fadedVolume(fadeFrom.current, left));
  });
  useEffect(() => sleepTick(sleepFor), [sleepFor]);
  // Leaving mid-fade, the next file plays at the volume from before it.
  useEffect(
    () => () => {
      if (fadeFrom.current !== undefined) Player.SetVolume(fadeFrom.current).catch(() => {});
    },
    [],
  );
  const changeSleep = (choice: (typeof sleepChoices)[number]["value"]) => {
    onSleepChange(sleepTimerFor(choice, fileKey, Date.now()));
    const name = sleepChoices.find((each) => each.value === choice)?.name ?? "";
    setNotice({
      text: choice === "off" ? "Sleep timer off" : `Sleep timer: ${name.toLowerCase()}`,
    });
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
    if (!feature("miniPlayer") || (!mini && !ready)) return;
    setMini(!mini);
    if (!mini) {
      setFullscreen(false);
      setHelpOpen(false);
      setSwitcherOpen(false);
      setPictureOpen(false);
      setSpeedOpen(false);
      setMoreOpen(false);
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
  // This device has subtitles on for every file, in its own style.
  const always = device?.subtitles?.always === true;
  const captionsOn =
    always ||
    settings?.captions === "on" ||
    (settings?.captions !== "off" && systemCaptions === true);
  useEffect(() => {
    if (!fileReady || !settings) return;
    if (added.load > 0) {
      // A reload: the addon subtitles that were showing, again.
      if (readdedFor.current === added.load) return;
      readdedFor.current = added.load;
      if (showingAddon.current) addSubtitles(showingAddon.current, false);
      return;
    }
    if (always) {
      // Every file starts with the subtitles it should have, chosen well
      // enough that nobody has to pick them. The file's own track is known
      // at once; an addon's waits for the addons to answer.
      if (autoDone.current) return;
      const pick = smartSubtitle(
        tracks,
        addonSubtitles.subtitles,
        wantedSubtitleLanguage(settings),
      );
      if (pick && "track" in pick) {
        autoDone.current = true;
        // An automatic pick is nobody's choice: the language isn't saved.
        if (!pick.track.selected) {
          setSubtitleId(pick.track.id);
          Player.SetSubtitleTrack(pick.track.id).catch(() => {});
        }
        return;
      }
      if (addonSubtitles.loading) return;
      autoDone.current = true;
      if (pick) addSubtitles(pick.addon, false);
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

  // How subtitles look: the profile's, or this device's when its subtitles
  // are always on; changed live from the panel or by keys (R and G nudge
  // their place and size). A change lasts until this video ends; "Save as my
  // style" is what makes it the profile's (or, always on, the device's).
  const [subStyle, setSubStyle] = useState<SubtitleStyle>();
  const savedStyle =
    always && device?.subtitles?.style?.font
      ? device.subtitles.style
      : settings?.subtitleStyle?.font
        ? settings.subtitleStyle
        : defaultSubtitleStyle;
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
    // Always on, the style belongs to the device: it's in the device's
    // subtitles, not the profile's.
    if (always) {
      if (!device) return;
      saveDevice.mutate({ ...device, subtitles: { ...device.subtitles, style } });
    } else if (settings) {
      saveSettings.mutate({ ...settings, subtitleStyle: style } satisfies ProfileSettings);
    } else return;
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
  // The touch player's pinch (#131): zoomed to fill (mpv's panscan 1, which
  // crops a wide film to a tall phone's shape) or the original picture.
  // Kept for the session, and for the title when there is one.
  const [sessionFill, setSessionFill] = useState<boolean>();
  const fill = sessionFill ?? adjustments?.fill ?? false;
  useEffect(() => {
    if (!touchLayout || !ready || state.loading) return;
    Player.SetPanscan(fill ? 1 : 0).catch(() => {});
  }, [touchLayout, ready, state.loading, fill, added.load]);
  const changeFill = (to: boolean) => {
    setSessionFill(to);
    setNotice({ text: to ? "Zoomed to fill" : "Original" });
    if (titleKey) saveAdjustments.mutate(withSection(adjustments, "fill", to));
  };
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

  // The picture moves left by the dock's width (Go's margin is a share of the
  // window, so it also takes it again when the window changes); back to 0
  // when the dock goes: undocked, closed, the mini player, the page.
  useEffect(() => {
    if (!dockShown) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const measured = dockRef.current?.getBoundingClientRect().width ?? 0;
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        Player.SetVideoInset(Math.round(measured || parseFloat(partyDockWidth) * rem)).catch(
          () => {},
        );
      }, 100);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", apply);
      Player.SetVideoInset(0).catch(() => {});
    };
  }, [dockShown]);

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
      // "Still watching?" has the keys: Enter answers, Esc leaves.
      if (asking !== undefined) {
        if (event.type === "keydown" && event.key === "Escape") leave();
        return;
      }
      if (error || switcherOpen || (partyOpen && !dockShown) || dockMenuOpen) return;
      // The docked party leaves the player its keys, but not while typing in
      // its chat (Esc leaves the field first), nor a press a focused control
      // of its own takes.
      const focused = event.target instanceof Element ? event.target : null;
      if (dockShown && focused && dockRef.current?.contains(focused)) {
        const typing =
          focused instanceof HTMLInputElement ||
          focused instanceof HTMLTextAreaElement ||
          (focused instanceof HTMLElement && focused.isContentEditable);
        if (typing) {
          if (event.type === "keydown" && event.key === "Escape") focused.blur();
          return;
        }
        if (
          (event.key === " " || event.key === "Enter") &&
          focused.closest("button, a, [role=switch], [role=checkbox], [role=menuitem]")
        )
          return;
      }
      if (event.metaKey || event.ctrlKey) return;
      // The iPad's keyboard (#138): what the iOS player can't do (framing,
      // full screen, the mini player, the switcher, frame steps, A–B loops,
      // screenshots, the picture and sound panels) takes no key, so a press
      // never opens state with nothing on screen. A watch party can, since
      // it is in the iOS app too (ADR-0063).
      const ios = isIOS();
      if (ios && event.altKey) return;
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
        S: () => takeScreenshot(true),
        I: () => ready && !mini && setStatsOpen(!statsOpen),
      };
      // Held down, these go on.
      const shiftedRepeating: Record<string, () => void> = {
        R: () => nudgeSubtitles(-liftStep, 0),
        G: () => nudgeSubtitles(0, sizeStep),
      };
      const shiftedAction =
        event.shiftKey && !(ios && iosShiftedOff.has(event.key))
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
        ",": () => stepFrame(true),
        ".": () => stepFrame(false),
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
        l: stepLoop,
        pageup: () => goToChapter(previousChapter(chapters, position)),
        pagedown: () => goToChapter(nextChapter(chapters, position)),
        "[": () => changeSpeed(stepSpeed(speed, -1)),
        "]": () => changeSpeed(stepSpeed(speed, 1)),
        backspace: () => speed !== normalSpeed && changeSpeed(normalSpeed),
        // The switcher is the host's: a guest's stream is the party's pick.
        ...(guest ? {} : { s: () => watching && openSwitcher() }),
        w: () => (watching || party) && openParty(),
        "?": () => !mini && setHelpOpen(!helpOpen),
        escape: () => {
          if (helpOpen) setHelpOpen(false);
          else if (statsOpen && !mini) setStatsOpen(false);
          else if (mini) toggleMini();
          else if (fullscreen) toggleFullscreen();
          else leave();
        },
      };
      const key = event.key.toLowerCase();
      if (ios && iosKeysOff.has(key)) return;
      // A focused slider moves itself with the arrows and Page Up/Down.
      if ((key.startsWith("arrow") || key.startsWith("page")) && event.defaultPrevented) return;
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
  const lockedNow = locked && !failure;
  const shown =
    !lockedNow &&
    (!idle ||
      paused ||
      !ready ||
      state.loading ||
      dragging ||
      over ||
      menuOpen ||
      helpOpen ||
      switcherOpen ||
      partyOpen ||
      dockMenuOpen ||
      episodesOpen ||
      scrub !== undefined);
  const shownRef = useRef(shown);
  shownRef.current = shown;
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
    touchLayout
      ? liftToClear(
          windowHeight,
          false,
          16,
          (bottomRow ? touchChromeRem.series : touchChromeRem.movie) +
            (reactionRow ? reactionRowRem : 0),
        )
      : liftToClear(
          windowHeight,
          mini,
          touch ? 20 : 16,
          // The reactions row rides on top of the dock: the subtitles clear it
          // too, while it shows.
          reactionRow ? dockClearanceRem + reactionRowRem : undefined,
        ),
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
          // The iPad's bottom row (#138): always open, as on the desktop bar.
          volumeSlider && !mini && "w-28",
          mini &&
            "w-0 overflow-hidden opacity-0 transition-[width,opacity] duration-200 group-focus-within/volume:w-24 group-focus-within/volume:opacity-100 group-hover/volume:w-24 group-hover/volume:opacity-100",
          !mini &&
            !volumeSlider &&
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
  const miniButton = feature("miniPlayer") && (
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
  const prompts = !failure && asking === undefined && (
    <div
      className={cn(
        "pointer-events-none absolute end-0 flex flex-col items-end gap-2.5 transition-[bottom] duration-300 ease-out-soft *:pointer-events-auto",
        mini
          ? "inset-x-2 bottom-16 items-stretch"
          : touch
            ? "pe-[calc(1rem+env(safe-area-inset-right))]"
            : "pe-8",
        // The touch chrome's (#130): bottom right, just above the seek row
        // (Netflix), and out of the way of a scrub.
        touchLayout &&
          (shown
            ? "bottom-[calc(var(--touch-chrome)+0.5rem)]"
            : "bottom-[calc(1rem+env(safe-area-inset-bottom))]"),
        touchLayout && scrub !== undefined && "opacity-0 *:pointer-events-none",
        !mini &&
          !touchLayout &&
          (shown
            ? "bottom-[calc(var(--dock-h)+1.25rem)]"
            : "bottom-[calc(2rem+env(safe-area-inset-bottom))]"),
      )}
    >
      {following && watching && party && !mini && (
        <PartyFollower
          key={JSON.stringify(following)}
          hold={hold}
          watching={watching}
          title={heading.title}
          party={party}
          expected={following}
          current={playing?.stream}
          onPicked={followPick}
        />
      )}
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
              <Button size="sm" variant="light" onClick={startNext}>
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
      {offerStartOver && !mini && !touchLayout && (
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
      {/* A guest's next episode is the party's, which the prompt above
          offers: the card would only get this device's pick ready. */}
      {meta && next && (counting || starting) && !partyNext && (
        <NextEpisode
          profileId={profileId}
          meta={meta}
          next={next}
          settings={settings}
          remaining={Math.max(0, state.duration - state.position)}
          share={from === undefined ? 0 : (state.position - from) / (state.duration - from)}
          starting={starting}
          mini={mini}
          compact={touchLayout}
          onPlay={startNext}
          onCancel={() => setCancelled(true)}
          onStart={(prepared) => void playNext(prepared)}
        />
      )}
    </div>
  );

  // The touch chrome (#130), after YouTube, Netflix and Infuse: a 44 pt top
  // row, the transport at the centre, a thin seek row at the bottom and, for
  // a series, a row of text buttons under it. While scrubbing only the seek
  // row stays, with the time it goes to large at the centre.
  // The picture's gestures on touch (#131, lib/player-gestures.ts): level
  // swipes on the sides, swipe to seek, hold for 2×, pinch to fill. Off
  // while locked, while a sheet is open (a tap closes it) and when the
  // stream failed. VoiceOver never reaches them: the picture is aria-hidden
  // and VoiceOver turns touches into its own gestures, so the buttons do it
  // all.
  const gesturesOn = touchLayout && !lockedNow && !failure && !panel && !episodesOpen;
  const gesture = useRef<{
    state: GestureState;
    points: Map<number, { x: number; y: number }>;
    holdTimer?: ReturnType<typeof setTimeout>;
    // The touch was a pan, hold or pinch: the click that may follow isn't a tap.
    notTap: boolean;
  }>({ state: gestureIdle, points: new Map(), notTap: false });
  const insetProbe = useRef<HTMLDivElement>(null);
  // The levels a swipe starts from; Go reads them, and the system volume's
  // changes come as an event (the hardware buttons' too).
  const levels = useRef({ brightness: -1, volume: -1 });
  const [hud, setHud] = useState<{ side: LevelSide; value: number; shown: boolean }>();
  const hudTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hudTimer.current), []);
  const showHud = (side: LevelSide, value: number, fadeSoon: boolean) => {
    clearTimeout(hudTimer.current);
    setHud({ side, value, shown: true });
    if (fadeSoon) {
      hudTimer.current = setTimeout(() => setHud((was) => was && { ...was, shown: false }), 600);
    }
  };
  const [brightener] = useState(() => latestOnly(Player.SetBrightness));
  const [systemVolumer] = useState(() => latestOnly(Player.SetSystemVolume));
  const onSystemVolume = useEffectEvent((level: number) => {
    levels.current.volume = level;
    const g = gesture.current.state;
    // A swipe's own change comes back here too; the swipe shows it already.
    if (g.kind === "level" && g.side === "volume") return;
    showHud("volume", level, true);
  });
  useEffect(() => {
    if (!touchLayout) return undefined;
    Player.Brightness()
      .then((v) => {
        levels.current.brightness = v;
      })
      .catch(() => {});
    Player.SystemVolume()
      .then((v) => {
        levels.current.volume = v;
      })
      .catch(() => {});
    return Events.On("player:system-volume", (event) => onSystemVolume(event.data));
  }, [touchLayout]);
  const [holding, setHolding] = useState(false);
  const heldSpeed = useRef<number>(undefined);
  const gestureContext = (box: DOMRect) => {
    const probe = insetProbe.current && getComputedStyle(insetProbe.current);
    return {
      width: box.width,
      height: box.height,
      insets: {
        top: px(probe?.paddingTop),
        right: px(probe?.paddingRight),
        bottom: px(probe?.paddingBottom),
        left: px(probe?.paddingLeft),
      },
      brightness: levels.current.brightness >= 0 ? levels.current.brightness : 0.5,
      volume: levels.current.volume >= 0 ? levels.current.volume : 0.5,
      position: positionRef.current,
      duration: known ? state.duration : 0,
      levels: ready && gestureSettings?.levelSwipes !== false,
      seek: ready && known && gestureSettings?.seekSwipe !== false,
      hold: ready && !paused && gestureSettings?.holdForSpeed !== false,
    };
  };
  const actOn = (out: GestureOutput | undefined) => {
    if (!out) return;
    switch (out.type) {
      case "level":
        levels.current[out.side] = out.value;
        showHud(out.side, out.value, false);
        if (out.side === "brightness") brightener(out.value);
        else systemVolumer(out.value);
        if (out.bump) haptic("light");
        return;
      case "level-end":
        if (hud) showHud(out.side, levels.current[out.side], true);
        return;
      case "scrub":
        setScrub({ from: out.from, to: out.to });
        seeker({ to: out.to, exact: false });
        return;
      case "seek":
        setScrub(undefined);
        seek(out.to);
        return;
      case "seek-cancel":
        setScrub(undefined);
        seek(out.from);
        return;
      case "hold":
        heldSpeed.current = speed;
        setHolding(true);
        Player.SetSpeed(2).catch(() => {});
        return;
      case "hold-end":
        if (heldSpeed.current !== undefined) {
          Player.SetSpeed(heldSpeed.current).catch(() => {});
          heldSpeed.current = undefined;
        }
        setHolding(false);
        return;
      case "pinch":
        if (ready) changeFill(out.fill);
        return;
      case "tap":
        return;
    }
  };
  const feed = (event: GestureEvent, box: DOMRect) => {
    const g = gesture.current;
    const step = reduceGesture(g.state, g.points, event, gestureContext(box));
    g.state = step.state;
    g.points = step.points;
    if (step.state.kind !== "pending" && step.state.kind !== "idle") g.notTap = true;
    clearTimeout(g.holdTimer);
    if (step.state.kind === "pending") {
      g.holdTimer = setTimeout(
        () => feed({ type: "tick", t: performance.now() }, box),
        Math.max(0, step.state.t0 + holdAfter - performance.now()),
      );
    }
    actOn(step.out);
  };
  // Lifting off a hold or a swipe when the gestures turn off mid-touch.
  useEffect(() => {
    if (gesturesOn) return;
    const g = gesture.current;
    clearTimeout(g.holdTimer);
    if (g.state.kind === "hold" && heldSpeed.current !== undefined) {
      Player.SetSpeed(heldSpeed.current).catch(() => {});
      heldSpeed.current = undefined;
      setHolding(false);
    }
    g.state = gestureIdle;
    g.points = new Map();
  }, [gesturesOn]);
  useEffect(() => () => clearTimeout(gesture.current.holdTimer), []);
  const pointer = (type: "down" | "move" | "up" | "cancel", event: React.PointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const t = performance.now();
    if (type === "down") {
      if (gesture.current.points.size === 0) gesture.current.notTap = false;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      feed({ type, id: event.pointerId, x, y, t }, box);
    } else if (type === "move") feed({ type, id: event.pointerId, x, y }, box);
    else if (type === "up") feed({ type, id: event.pointerId, t }, box);
    else feed({ type, id: event.pointerId }, box);
  };
  const lock = () => {
    setPanel(undefined);
    setEpisodesOpen(false);
    setMoreOpen(false);
    setSpeedOpen(false);
    setLocked(true);
    setLockPill(true);
  };
  const reportProblem = () => {
    Diagnostics.ShareLogs().catch(() => setNotice({ text: "Couldn’t share the logs" }));
  };

  const scrubbing = scrub !== undefined;
  const faded = scrubbing && "pointer-events-none opacity-0";
  const episodeList = meta && series ? episodesOf(meta) : [];
  // The top row's Watch party (ADR-0063): the sheet the desktop's W key and
  // Users button open, under the same conditions (a party, or something
  // playing to start one with).
  const touchParty =
    feature("party") && (watching || party)
      ? {
          open: partyOpen,
          inParty: party !== undefined,
          unread: partyChat.unread > 0,
          onOpen: openParty,
        }
      : undefined;
  const touchControls = touchLayout && (
    <>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-24 bg-linear-to-b from-black/55 to-transparent transition-opacity duration-200",
          faded,
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-30 bg-linear-to-t from-black/65 to-transparent"
      />
      <TouchTopRow
        {...hold}
        className={faded}
        title={playing?.title}
        episode={playing?.episode}
        onBack={leave}
        onLock={ready ? lock : undefined}
        tracks={
          ready && (subtitlesMenu || audioTracks.length > 1)
            ? {
                open: panel !== undefined,
                on: subtitleId > 0,
                onOpen: () => openPanel("subtitles"),
              }
            : undefined
        }
        party={touchParty}
        more={
          ready && (
            <TouchMoreMenu
              open={moreOpen}
              onOpenChange={setMoreOpen}
              speed={bottomRow ? undefined : { speed, onChange: changeSpeed }}
              sleep={{
                choice: sleepChoiceOf(sleep),
                hint: sleepHint(sleep, sleepFor),
                episodeKnown: known,
                onChange: changeSleep,
              }}
              stats={{ open: statsOpen, onToggle: () => setStatsOpen(!statsOpen) }}
              shortcuts={
                desktopControls
                  ? {
                      open: helpOpen,
                      onToggle: () => {
                        setPanel(undefined);
                        setHelpOpen(!helpOpen);
                      },
                    }
                  : undefined
              }
              onReport={isIOS() ? reportProblem : undefined}
            />
          )
        }
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-0 flex items-center justify-center gap-14 transition-opacity duration-200",
          shown && !scrubbing && "*:pointer-events-auto",
          faded,
        )}
      >
        <GlassButton
          label={`Back ${skipBy} seconds`}
          size="skip"
          aria-keyshortcuts="ArrowLeft"
          onClick={() => seek(position - skipBy)}
          disabled={!ready || !known}
        >
          <RotateCcw />
          <span aria-hidden className="absolute text-[0.5625rem] font-semibold">
            {skipBy}
          </span>
        </GlassButton>
        <GlassButton
          label={paused ? "Play" : "Pause"}
          size="play"
          aria-keyshortcuts="Space K"
          onClick={togglePause}
          disabled={!ready}
        >
          {paused ? (
            <Play className="translate-x-0.5 fill-current" />
          ) : (
            <Pause className="fill-current" />
          )}
        </GlassButton>
        <GlassButton
          label={`Forward ${skipBy} seconds`}
          size="skip"
          aria-keyshortcuts="ArrowRight"
          onClick={() => seek(position + skipBy)}
          disabled={!ready || !known}
        >
          <RotateCw />
          <span aria-hidden className="absolute text-[0.5625rem] font-semibold">
            {skipBy}
          </span>
        </GlassButton>
      </div>
      <div
        {...hold}
        className="absolute inset-x-0 bottom-0 flex flex-col ps-[calc(1rem+env(safe-area-inset-left))] pe-[calc(1rem+env(safe-area-inset-right))] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {/* The party's reactions (ADR-0051): a row above the seek bar, so
            reacting is a tap on the picture, not a trip to the chat. It fades
            while scrubbing, when the seek row has the room. */}
        {reactionRow && <ReactionBar chrome className={cn("mb-1", faded)} />}
        <div data-testid="seek-row" className="flex h-8 items-center gap-3">
          {known && (
            <p
              data-testid="elapsed"
              className={cn(
                "shrink-0 text-[0.75rem] font-[600] text-white tnum",
                hours ? "w-[7ch]" : "w-[5ch]",
              )}
            >
              {formatTime(scrub?.to ?? position)}
            </p>
          )}
          <div className="min-w-0 flex-1">
            <SeekBar
              touch
              scrubAt={scrub?.to}
              position={position}
              duration={state.duration}
              buffered={state.buffered}
              segments={segments}
              loop={loop}
              playing={!paused && ready}
              onScrub={scrubTo}
              onSeek={(to) => {
                seek(to);
                endScrub(false);
              }}
              onDraggingChange={(on) => {
                setDragging(on);
                if (!on) setScrub(undefined);
              }}
            />
          </div>
          {known && (
            <p
              data-testid="remaining"
              className={cn(
                "shrink-0 text-end text-[0.75rem] font-[600] text-white/70 tnum",
                hours ? "w-[8ch]" : "w-[6ch]",
              )}
            >
              -{formatTime(Math.max(0, state.duration - (scrub?.to ?? position)))}
            </p>
          )}
          {known && (
            <PlayerEndsAt
              remaining={Math.max(0, state.duration - (scrub?.to ?? position))}
              speed={speed}
              className="text-[0.75rem] font-[600]"
            />
          )}
        </div>
        {bottomRow && (
          <div
            data-testid="bottom-row"
            className={cn(
              "-ms-2.5 flex h-8 items-center gap-1 transition-opacity duration-200",
              faded,
            )}
          >
            {ready && (
              <TouchSpeedMenu
                speed={speed}
                onChange={changeSpeed}
                open={speedOpen}
                onOpenChange={setSpeedOpen}
              />
            )}
            {episodeList.length > 0 && (
              <RowButton
                icon={<Layers aria-hidden />}
                aria-expanded={episodesOpen}
                onClick={() => {
                  setPanel(undefined);
                  setEpisodesOpen(!episodesOpen);
                }}
              >
                Episodes
              </RowButton>
            )}
            {ready && next && !starting && (
              <RowButton
                icon={<SkipForward aria-hidden className="fill-current" />}
                onClick={startNext}
              >
                Next episode
              </RowButton>
            )}
            {volumeSlider && <div className="ms-auto">{volumeControl}</div>}
          </div>
        )}
      </div>
      {scrub && <ScrubLabel from={scrub.from} to={scrub.to} />}
    </>
  );
  // "Resumed at 12:34 · Start over" on touch: a small quiet pill in the top
  // corner under the top row, so it stays out of the picture.
  const resumePill = offerStartOver && !failure && asking === undefined && (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 top-[calc(3.5rem+env(safe-area-inset-top))] flex justify-start ps-[max(1rem,env(safe-area-inset-left))] pe-4 *:pointer-events-auto",
        faded,
      )}
    >
      <Prompt
        {...hold}
        className="gap-2 rounded-full py-1 ps-3 pe-1"
        action={
          <Button
            size="sm"
            variant="light"
            className="h-7 rounded-full px-2.5 text-xs"
            onClick={startOver}
          >
            <RotateCcw className="size-3" />
            Start over
          </Button>
        }
      >
        <span className="text-xs text-white/80">
          Resumed at <span className="tnum">{formatTime(resumedAt)}</span>
        </span>
      </Prompt>
    </div>
  );
  // The party's line (ADR-0063): at the top of the picture as on the desktop,
  // but under the touch player's own top row, and under the resume pill
  // when that is up.
  const partyPillTop = touchLayout
    ? resumePill
      ? "top-[calc(6.5rem+env(safe-area-inset-top))]"
      : "top-[calc(3.75rem+env(safe-area-inset-top))]"
    : undefined;

  return (
    <div
      // --above-bar is where the overlays sit: above the dock.
      className={cn(
        // Narrowed by the docked party, which sits to its right: everything
        // the player draws (the bar, the top, the flash, the cards, the
        // subtitle lift) is inside this box and moves in with it.
        "fixed inset-y-0 left-0 right-(--party-dock-w) text-white select-none",
        // The party's reactions are a row of the controls while it runs, so
        // the dock (and --above-bar and the prompts with it) and the touch
        // chrome grow by that row rather than the row growing into them.
        reactionRow ? "[--party-row:2.75rem]" : "[--party-row:0rem]",
        // env() is the home indicator on iOS (the webview fills the screen,
        // build/ios/main.m) and 0 elsewhere.
        touch
          ? "[--dock-h:calc(10rem+var(--party-row)+env(safe-area-inset-bottom))]"
          : "[--dock-h:calc(7.5rem+var(--party-row))]",
        // The touch chrome's height (#130): the seek row, and the bottom row
        // for a series, over the home indicator.
        touchLayout &&
          (bottomRow
            ? "[--touch-chrome:calc(max(0.5rem,env(safe-area-inset-bottom))+4rem+var(--party-row))]"
            : "[--touch-chrome:calc(max(0.5rem,env(safe-area-inset-bottom))+2rem+var(--party-row))]"),
        mini ? "[--above-bar:6.25rem]" : "[--above-bar:calc(var(--dock-h)+1.5rem)]",
        !shown && "cursor-none",
      )}
      style={dockStyle}
      onPointerMove={(event) => {
        // A swipe on the picture changes a level or seeks: the controls
        // stay as they were (#131).
        if (touchLayout && event.pointerType === "touch" && event.target === surface.current)
          return;
        wake();
      }}
      // A touch on the picture is the tap's to judge (tapPicture): woken
      // here first, the controls it should show were up already, and the
      // tap hid them again.
      onPointerDown={(event) => {
        if (event.pointerType !== "touch" || event.target !== surface.current) wake();
      }}
    >
      {/* The video itself: a click pauses, a double click goes fullscreen
          (or, from the mini player, back to the app window). The Play
          button is the one to reach by keyboard. */}
      <button
        ref={surface}
        type="button"
        tabIndex={-1}
        aria-hidden
        className={cn(
          "absolute inset-0 outline-none",
          touchLayout && "touch-none",
          !shown ? "cursor-none" : framing.zoom !== 0 && ready ? "cursor-grab" : "cursor-default",
        )}
        onPointerDown={(event) => {
          surfacePointer.current = event.pointerType;
          if (touchLayout) {
            // A trackpad or mouse on an iPad (#138) clicks as on the
            // desktop: no swipes, and a click pauses (onClick).
            if (gesturesOn && event.pointerType !== "mouse") pointer("down", event);
            return;
          }
          if (!ready || mini || framing.zoom === 0 || event.button !== 0) return;
          panDrag.current = { x: event.clientX, y: event.clientY, start: framing };
          dragged.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (touchLayout) {
            if (gesturesOn && event.pointerType !== "mouse") pointer("move", event);
            return;
          }
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
        onPointerUp={(event) => {
          if (touchLayout) {
            if (gesturesOn && event.pointerType !== "mouse") pointer("up", event);
            return;
          }
          const drag = panDrag.current;
          panDrag.current = undefined;
          if (drag?.last) changeFraming(drag.last);
        }}
        onPointerCancel={(event) => {
          if (touchLayout) {
            if (gesturesOn && event.pointerType !== "mouse") pointer("cancel", event);
            return;
          }
          panDrag.current = undefined;
        }}
        onClick={(event) => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          if (touchLayout && lockedNow) {
            setLockPill(true);
            return;
          }
          if (touchLayout && gesture.current.notTap) {
            gesture.current.notTap = false;
            return;
          }
          if (panel || pictureOpen || episodesOpen) {
            setPanel(undefined);
            setPictureOpen(false);
            setEpisodesOpen(false);
          } else if (touch && surfacePointer.current !== "mouse") {
            tapPicture(event.clientX, event.currentTarget.getBoundingClientRect());
          } else togglePause();
        }}
        onDoubleClick={touch ? undefined : mini ? toggleMini : toggleFullscreen}
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
        {touchLayout ? (
          touchControls
        ) : (
          <>
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
                mini
                  ? "h-14 pt-2 pr-3 pl-2"
                  : touch
                    ? "pt-[calc(0.5rem+env(safe-area-inset-top))] pr-[calc(0.75rem+env(safe-area-inset-right))] pl-[calc(0.75rem+env(safe-area-inset-left))]"
                    : "pt-3 pr-5 pl-[5.75rem]",
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
                        : touch
                          ? "font-display text-[1.5rem] leading-none font-normal"
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
                  {feature("party") && (watching || party) && (
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
                  {watching && feature("streamSwitcher") && !guest && (
                    <ControlButton
                      label="Streams"
                      icon={ListVideo}
                      onClick={openSwitcher}
                      aria-keyshortcuts="S"
                      aria-expanded={switcherOpen}
                    />
                  )}
                  {desktopControls && (
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
                  )}
                  {miniButton}
                  {desktopControls && (
                    <ControlButton
                      label={fullscreen ? "Exit full screen" : "Full screen"}
                      icon={fullscreen ? Minimize : Maximize}
                      onClick={toggleFullscreen}
                      aria-keyshortcuts="F"
                    />
                  )}
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
                  : touch
                    ? "inset-x-0 bottom-0 h-(--dock-h) justify-end gap-1 ps-[calc(1rem+env(safe-area-inset-left))] pe-[calc(1rem+env(safe-area-inset-right))] pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
                    : "inset-x-0 bottom-0 h-(--dock-h) justify-end gap-1 px-8 pb-5",
              )}
            >
              {/* The party's reactions (ADR-0051): centred over the timeline,
                  so reacting is a move of the cursor and a click. Inside the
                  dock, they fade with it. */}
              {reactionRow && <ReactionBar chrome />}
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
                    loop={loop}
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
                {timeShown && !mini && (
                  <PlayerEndsAt
                    remaining={Math.max(0, state.duration - position)}
                    speed={speed}
                    className="-ms-2 text-small font-[590]"
                  />
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
                <div
                  className={cn(
                    touch
                      ? "flex flex-col items-center gap-1"
                      : "grid grid-cols-[1fr_auto_1fr] items-center",
                  )}
                >
                  {!touch && <div className="flex items-center gap-1">{volumeControl}</div>}
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
                  <div
                    className={cn(
                      "flex items-center gap-1.5",
                      touch ? "justify-center" : "justify-self-end",
                    )}
                  >
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
                    {ready && feature("playerPanels") && (
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
                    {ready && feature("playerPanels") && (
                      <MoreMenu
                        open={moreOpen}
                        onOpenChange={setMoreOpen}
                        chapters={{
                          chapters,
                          current: chapterAt(chapters, position),
                          onPick: (index) =>
                            goToChapter(chapters[index] && { index, chapter: chapters[index] }),
                        }}
                        loop={{
                          loop,
                          onNext: stepLoop,
                          onClear: () => changeLoop({}, "A–B loop off"),
                        }}
                        onScreenshot={takeScreenshot}
                        stats={{ open: statsOpen, onToggle: () => setStatsOpen(!statsOpen) }}
                        sleep={{
                          choice: sleepChoiceOf(sleep),
                          hint: sleepHint(sleep, sleepFor),
                          episodeKnown: known,
                          onChange: changeSleep,
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {!lockedNow && prompts}
      {touchLayout && !lockedNow && resumePill}
      {touchLayout && (
        <>
          {/* Reads the safe-area insets for the gestures' dead zones. */}
          <div
            ref={insetProbe}
            aria-hidden
            className="pointer-events-none invisible absolute pt-[env(safe-area-inset-top)] pe-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] ps-[env(safe-area-inset-left)]"
          />
          {ripple && <SkipRipple side={ripple.side} seconds={ripple.total} />}
          {hud && <LevelHud side={hud.side} value={hud.value} shown={hud.shown} />}
          {holding && <HoldPill />}
          {lockedNow && <LockPill shown={lockPill} onUnlock={() => setLocked(false)} />}
        </>
      )}
      {asking !== undefined && !failure && (
        <StillWatching
          title={meta?.name ?? playing?.title ?? ""}
          episodes={asking}
          mini={mini}
          onContinue={() => {
            streak.current = 0;
            setAsking(undefined);
            startNext();
          }}
          onStop={leave}
        />
      )}
      <SubtitlePanel
        open={
          panel !== undefined &&
          !mini &&
          !failure &&
          // The touch player lists tracks in its own sheet (#130), and
          // opens this panel for the style.
          (!touchLayout || panel === "style")
        }
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
      {touchLayout && !failure && (panel === "subtitles" || panel === "audio") && (
        <TracksSheet
          onClose={() => setPanel(undefined)}
          audioTracks={audioTracks}
          audioId={audioId}
          onPickAudio={pickAudio}
          subtitleTracks={subtitleTracks}
          addedIds={new Set(added.ids.values())}
          subtitleId={subtitleId}
          onPickTrack={pickSubtitles}
          addonSubtitles={addonSubtitles.subtitles}
          addonLoading={addonSubtitles.loading}
          addonKey={addonKey}
          loadingKey={loadingKey}
          onPickAddon={(subtitle) => addSubtitles(subtitle, true)}
          preferredLanguage={settings?.subtitleLanguage ?? ""}
          delay={subtitleDelay}
          onDelayChange={(by) => timeSubtitlesBy(by)}
          onStyle={() => setPanel("style")}
        />
      )}
      {touchLayout && !failure && episodesOpen && meta && series && (
        <EpisodesSheet
          profileId={profileId}
          meta={meta}
          playing={series.videoId}
          onPick={chooseEpisode}
          onClose={() => setEpisodesOpen(false)}
        />
      )}
      {feature("playerPanels") && (
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
      )}
      {watching && feature("streamSwitcher") && !guest && (
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
          playingDownload={downloaded}
          status={switchStatus}
          onPick={(candidate, names, refresh) => void switchStream(candidate, names, refresh)}
          onPickDownload={(playable) => void switchToDownload(playable)}
        />
      )}
      {dockShown && (
        <div
          ref={dockRef}
          // Just outside the narrowed player, filling the height.
          className="absolute top-0 bottom-0 left-full w-(--party-dock-w)"
        >
          <PartyDock onClose={() => setPartyOpen(false)} canShare={shared !== undefined} />
        </div>
      )}
      <PartySheet
        open={partyOpen && !mini && !docked}
        onOpenChange={setPartyOpen}
        state={partyState}
        media={media}
        canShare={shared !== undefined}
      />
      {party && !mini && <PartyReactionLayer />}
      {!mini && !failure && (
        <PartyPill
          state={partyState}
          notice={partyNotice}
          onCatchUp={() => void Party.CatchUp().catch(() => {})}
          className={partyPillTop}
        />
      )}
      {helpOpen && !failure && !mini && desktopControls && (
        <ShortcutsOverlay onClose={() => setHelpOpen(false)} guest={guest} />
      )}
      {statsOpen && ready && !mini && <StatsOverlay onClose={() => setStatsOpen(false)} />}
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
              <Button variant="media" size="lg" onClick={anotherStream} disabled={retrying}>
                {guest ? "Try another stream" : "Choose another stream"}
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

// Where a screenshot's toast shows it.
const fileManager = navigator.userAgent.includes("Mac")
  ? "Show in Finder"
  : "Show in File Explorer";
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

// Follows the host onto the stream they switched to: the chooser runs again
// against it, and while it works the player says so. It plays on with the old
// stream when nothing opens, and offers to try again, never a list.
function PartyFollower({
  hold,
  watching,
  title,
  party,
  expected,
  current,
  onPicked,
}: {
  hold: { onPointerEnter: () => void; onPointerLeave: () => void };
  watching: Watching;
  title: string;
  party: PartyInfo;
  expected: PartySource;
  current: Stream | undefined;
  onPicked: (picked: PartyPicked, onFail: () => void) => void;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  // The party's state can trail its notice: wait for the new source so the
  // chooser doesn't match the one just left.
  const arrived = JSON.stringify(party.media.source) === JSON.stringify(expected);
  const pick = usePartyAutoPick({
    profileId: watching.profileId,
    type: watching.contentType,
    id: watching.contentId,
    video: watching.videoId,
    title,
    party,
    enabled: arrived,
    open: false,
    current,
    onPicked: (picked) => {
      setLoadFailed(false);
      onPicked(picked, () => setLoadFailed(true));
    },
  });
  if (pick.status === "failed" || loadFailed) {
    return (
      <Prompt
        {...hold}
        icon={<Users />}
        action={
          <Button
            size="sm"
            variant="light"
            onClick={() => {
              setLoadFailed(false);
              pick.retry();
            }}
          >
            Try again
          </Button>
        }
      >
        Couldn’t switch to {pick.hostName}’s new stream
      </Prompt>
    );
  }
  if (pick.status === "done") return null;
  return (
    <Prompt {...hold} icon={<Users />}>
      {pick.hostName} switched streams: switching too…
    </Prompt>
  );
}
