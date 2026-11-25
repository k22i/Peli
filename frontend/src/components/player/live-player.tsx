import { useQuery } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { SeekBar } from "@/components/player/seek-bar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  channelsIn,
  clockLabel,
  neighbourChannel,
  nowNextFor,
  nowNextQuery,
  useFavourites,
  useLiveChannels,
  usePlayChannel,
  type LivePlay,
} from "@/lib/livetv";
import { isIOS, isTouch } from "@/lib/platform";
import {
  latestOnly,
  Player,
  useAhead,
  useIdle,
  usePlayerEnded,
  usePlayerState,
} from "@/lib/player";
import { useCurrentProfile } from "@/lib/profile";
import { cn } from "@/lib/utils";

// The player screen for a live channel (ADR-0066, W7). It is deliberately
// small: a live stream has no progress, resume, watched marks, next episode,
// skip markers, downloads, seek previews, stream switcher or party, and none
// of them belong here. What it has is the channel, what it shows now, the
// group's neighbours (Page Up and Page Down) and, when mpv reports a DVR
// window, a seek bar with Go live.
//
// The stream was already loaded (Player.Load) by usePlayChannel before this
// screen opened, so nothing here loads a channel except a channel change.
// A channel change replaces the history entry; PlayerPage keys this screen on
// the channel id, so a new one mounts with its own state.

// How long the pointer and keys can be still before the controls hide.
const idleAfter = 3000;

// A swipe on the touch channel strip, in px: up is the next channel.
const swipeStep = 40;

// The arrows' steps: volume in percent, and a seek in seconds.
const volumeStep = 5;
const skipBy = 10;

// "Go live" hides near the live edge: a seek under this many seconds behind
// it would move the picture by nothing worth a button.
const liveEdge = 10;

export function LivePlayer({ live }: { live: LivePlay }) {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const profileId = useCurrentProfile().id ?? 0;

  const { channels } = useLiveChannels(profileId);
  const favourites = useFavourites(profileId);
  const channel = channels.find((each) => each.id === live.channelId);
  // The channels Page Up and Page Down move through: the group the /live page
  // opened this channel from (all of them for "").
  const strip = useMemo(
    () => channelsIn(channels, live.group, favourites, ""),
    [channels, live.group, favourites],
  );
  const previous = useMemo(
    () => neighbourChannel(strip, live.channelId, -1),
    [strip, live.channelId],
  );
  const next = useMemo(() => neighbourChannel(strip, live.channelId, 1), [strip, live.channelId]);

  const nowNext = nowNextFor(
    useQuery(nowNextQuery(profileId, [live.channelId])).data,
    live.channelId,
  );
  const now = nowNext?.now ?? undefined;
  const upcoming = nowNext?.next ?? undefined;
  // The guide's title when there is a programme, the channel without one.
  const heading = now?.title || channel?.name || "Live TV";
  const channelName = channel?.name ?? "";

  const state = usePlayerState();
  const play = usePlayChannel();

  // A live stream that ends — eof or error — has stopped playing: the channel
  // went away. It is never the film player's error screen.
  const [failed, setFailed] = useState(false);
  usePlayerEnded(() => setFailed(true));

  const [idle, wake, hideControls] = useIdle(idleAfter);
  // The controls show while the pointer is about, and stay up while paused or
  // failed: there is nothing else to look at then.
  const shown = !idle || state.paused || failed;

  const touch = isTouch();
  const ios = isIOS();

  // The volume the user just set, shown until the player's own catches up.
  const [volume, setVolume] = useAhead(state.volume, (a, b) => Math.abs(a - b) < 1.5);
  // A drag or a key burst sends one call at a time, the newest next.
  const [scrub] = useState(() => latestOnly((position: number) => Player.Scrub(position)));
  const [seek] = useState(() => latestOnly((position: number) => Player.Seek(position)));
  const [volumer] = useState(() => latestOnly(Player.SetVolume));

  const leave = () => (canGoBack ? router.history.back() : void navigate({ to: "/live" }));
  const togglePause = () => void Player.SetPaused(!state.paused).catch(() => {});
  const toggleMute = () => void Player.SetMuted(!state.muted).catch(() => {});
  const toggleFullscreen = () => void Player.SetFullscreen(!state.fullscreen).catch(() => {});
  // A channel change loads the new stream and replaces the history entry, so
  // Back leaves the player rather than walking back through the channels.
  const playNeighbour = (step: 1 | -1) => {
    const wanted = neighbourChannel(strip, live.channelId, step);
    if (wanted) void play(wanted, live.group, { replace: true });
  };
  const changeVolume = (to: number) => {
    setVolume(to);
    volumer(to);
  };
  const stepVolume = (by: number) => changeVolume(Math.max(0, Math.min(100, volume + by)));

  // What the OS shows as playing, and what its media keys play and pause.
  useEffect(() => {
    Player.SetNowPlaying({ title: heading, subtitle: channelName }).catch(() => {});
  }, [heading, channelName]);

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    wake();
    // A field keeps its own keys: the volume slider's arrows move it, as the
    // browser does.
    if (event.target instanceof HTMLInputElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    // Held down, the arrows go on; a press acts once.
    if (key === "arrowup" || key === "arrowdown") {
      event.preventDefault();
      return stepVolume(key === "arrowup" ? volumeStep : -volumeStep);
    }
    if (key === "arrowleft" || key === "arrowright") {
      if (!state.seekable) return;
      event.preventDefault();
      void Player.SeekBy(key === "arrowleft" ? -skipBy : skipBy).catch(() => {});
      return;
    }
    if (event.repeat) return;
    switch (key) {
      case " ":
      case "k":
        event.preventDefault();
        return togglePause();
      case "m":
        event.preventDefault();
        return toggleMute();
      case "f":
        // iOS has no full screen: the picture is the whole app already.
        if (ios) return;
        event.preventDefault();
        return toggleFullscreen();
      case "escape":
        if (state.fullscreen) Player.SetFullscreen(false).catch(() => {});
        else leave();
        return;
      case "pageup":
        event.preventDefault();
        return playNeighbour(-1);
      case "pagedown":
        event.preventDefault();
        return playNeighbour(1);
      default:
        return undefined;
    }
  });
  // The one listener, attached after each render so it always sees the
  // current channel, state and group (as the film player's keys do).
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  // The channel strip's swipe: up for the next channel, down for the previous
  // one, as the list reads.
  const downY = useRef(0);

  return (
    <div
      className={cn("fixed inset-0 select-none text-white", !shown && "cursor-none")}
      onPointerMove={wake}
      // A touch on the picture is the tap's to judge below: woken here first,
      // the controls it should show would be up already, and the tap hid them
      // again (as the film player's picture does).
      onPointerDown={(event) => {
        if (event.pointerType !== "touch" || event.target !== event.currentTarget) wake();
      }}
      onClick={(event) => {
        if (!touch || event.target !== event.currentTarget) return;
        if (shown) hideControls();
        else wake();
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-linear-to-b from-black/70 to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-linear-to-t from-black/70 to-transparent"
      />

      {failed && (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="rounded-2xl bg-black/70 p-6 text-center backdrop-blur">
            <h2 className="text-lg font-semibold">Channel unavailable</h2>
            <p className="mt-1 text-white/70">
              {channelName || heading} isn&rsquo;t playing right now.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button
                variant="light"
                onClick={() => {
                  // The same channel again is the same history entry, so this
                  // screen stays: its failure has to be cleared here.
                  setFailed(false);
                  if (channel) void play(channel, live.group, { replace: true });
                }}
                disabled={channel === undefined}
              >
                Try again
              </Button>
              {next && (
                <Button variant="outline" onClick={() => playNeighbour(1)}>
                  Next channel
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {(state.loading || state.buffering) && !failed && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Spinner aria-label="Loading" className="size-8" />
        </div>
      )}

      <div className={cn("transition-opacity", !shown && "pointer-events-none opacity-0")}>
        <div className="absolute inset-x-0 top-0 flex items-start gap-4 p-6 pt-[max(1.5rem,env(safe-area-inset-top))]">
          <Button variant="ghost" size="icon" aria-label="Back" onClick={leave}>
            <ChevronLeft />
          </Button>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex items-center gap-2 text-small font-medium">
              <span className="rounded-sm bg-red-600 px-1.5 py-0.5 text-[0.6875rem] font-bold tracking-wide">
                LIVE
              </span>
              {channel && (
                <>
                  <span className="tnum">{channel.number}</span>
                  <span className="truncate">{channel.name}</span>
                </>
              )}
            </p>
            <h1 className="truncate text-xl font-semibold">{heading}</h1>
            {now && (
              <p className="text-small text-white/70 tnum">
                {clockLabel(now.start)}–{clockLabel(now.stop)}
                {upcoming && ` · Next ${clockLabel(upcoming.start)} ${upcoming.title}`}
              </p>
            )}
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {touch && (
            <nav
              aria-label="Channels"
              className="mx-auto flex items-center gap-3 rounded-full bg-black/50 px-4 py-2 backdrop-blur"
              onPointerDown={(event) => {
                event.stopPropagation();
                downY.current = event.clientY;
              }}
              onPointerUp={(event) => {
                event.stopPropagation();
                const dy = event.clientY - downY.current;
                if (dy < -swipeStep) playNeighbour(1);
                else if (dy > swipeStep) playNeighbour(-1);
              }}
            >
              {previous && <span className="text-white/60">{previous.name}</span>}
              <span className="font-semibold">{channelName || heading}</span>
              {next && <span className="text-white/60">{next.name}</span>}
            </nav>
          )}

          {/* A DVR window: mpv can seek, so the picture can go back and catch
          up. A plain live stream has nothing to seek through. */}
          {state.seekable && state.duration > 0 && (
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <SeekBar
                  position={state.position}
                  duration={state.duration}
                  buffered={state.buffered}
                  segments={[]}
                  playing={!state.paused}
                  onScrub={scrub}
                  onSeek={seek}
                  onDraggingChange={noDragging}
                  touch={touch}
                />
              </div>
              {state.duration - state.position > liveEdge && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void Player.Seek(state.duration).catch(() => {})}
                >
                  Go live
                </Button>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={state.paused ? "Play" : "Pause"}
              onClick={togglePause}
            >
              {state.paused ? <Play /> : <Pause />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous channel"
              onClick={() => playNeighbour(-1)}
              disabled={previous === undefined}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next channel"
              onClick={() => playNeighbour(1)}
              disabled={next === undefined}
            >
              <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={state.muted ? "Unmute" : "Mute"}
              onClick={toggleMute}
            >
              {state.muted ? <VolumeX /> : <Volume2 />}
            </Button>
            {/* A finger changes the device's volume instead (iOS), so the
            slider is the desktop's. */}
            {!touch && (
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                aria-label="Volume"
                value={volume}
                onChange={(event) => changeVolume(Number(event.target.value))}
                className="w-24 accent-white"
              />
            )}
            <div className="flex-1" />
            {!ios && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={state.fullscreen ? "Exit full screen" : "Full screen"}
                onClick={toggleFullscreen}
              >
                {state.fullscreen ? <Minimize /> : <Maximize />}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// The seek bar asks when a drag begins and ends; nothing here fades for a
// scrub.
const noDragging = () => {};
