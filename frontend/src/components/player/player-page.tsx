import { Slider } from "@base-ui/react/slider";
import { useCanGoBack, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  AlertCircle,
  ChevronLeft,
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
import { useEffect, useRef, useState, type ReactNode } from "react";

import { SeekBar } from "@/components/player/seek-bar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { repaintWindow } from "@/lib/theme";
import {
  formatTime,
  latestOnly,
  Player,
  reloadExpired,
  useAhead,
  useIdle,
  usePlayerEnded,
  usePlayerState,
  type Ended,
} from "@/lib/player";
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

// The player screen: the video under a transparent page, with no app shell,
// and the controls over it (#61). They show on any move or key and hide
// after a few still seconds while playing, with the cursor. Everything the
// user does shows at once and catches up with mpv after (useAhead): round
// trips reach 100 ms and more on slow machines. A click or Space pauses, a
// double click goes fullscreen, Esc leaves fullscreen or the screen. A
// torrent (#55) shows its peers, speed and buffer at the top, and under the
// spinner while it waits for pieces.
export function PlayerPage() {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const playing = useLocation({ select: (location) => location.state.player });
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

  const [paused, setPaused] = useAhead(state.paused, same);
  const [position, setPosition] = useAhead(state.position, near);
  const [volume, setVolume] = useAhead(state.volume, near);
  const [muted, setMuted] = useAhead(state.muted, same);
  const [fullscreen, setFullscreen] = useAhead(state.fullscreen, same);
  // One seek and one volume change at a time, the newest next.
  const [seeker] = useState(() =>
    latestOnly(({ to, exact }: { to: number; exact: boolean }) =>
      exact ? Player.Seek(to) : Player.Scrub(to),
    ),
  );
  const [volumer] = useState(() => latestOnly(Player.SetVolume));
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  const [idle, wake] = useIdle(idleAfter);

  const leave = () => (canGoBack ? router.history.back() : void navigate({ to: "/" }));
  // Leaving the screen, however it happens, ends the session, and lets the
  // torrent go once mpv no longer reads it.
  useEffect(
    () => () => {
      const streamed = isTorrentSource(source.current);
      Player.Stop()
        .catch(() => {})
        .finally(() => {
          repaintWindow();
          if (streamed) Torrents.Release().catch(() => {});
        });
    },
    [],
  );
  usePlayerEnded((ended) => {
    if (ended.reason === "eof") return leave();
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
      reloadExpired(expired, state.position).then(
        (fresh) => {
          source.current = fresh;
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
      if (ended.code === "expired" && !isTorrentSource(current))
        source.current = await reloadExpired(current, stoppedAt.current);
      else await Player.Load(current, { start: stoppedAt.current });
      setError(undefined);
    } catch {
      // Still failed: the overlay stays.
    } finally {
      setRetrying(false);
    }
  };

  const ready = state.active && !error;
  const known = state.duration > 0;
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      wake();
      if (error) return;
      if (event.key === "Escape") {
        if (event.type !== "keydown") return;
        if (fullscreen) toggleFullscreen();
        else leave();
      } else if (event.key === " ") {
        // Not a click on the focused button too, as its key comes up.
        event.preventDefault();
        if (event.type === "keydown" && !event.repeat) togglePause();
      }
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
  const waiting = !failure && (state.loading || state.buffering || seekingLate);
  const shown = !idle || paused || !ready || state.loading || dragging || over;
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
              disabled={!ready}
              fill
            />
            <ControlButton
              label="Back 10 seconds"
              icon={RotateCcw}
              onClick={() => seek(position - skip)}
              disabled={!ready || !known}
              badge={skip}
            />
            <ControlButton
              label="Forward 10 seconds"
              icon={RotateCw}
              onClick={() => seek(position + skip)}
              disabled={!ready || !known}
              badge={skip}
            />
            <div className="group/volume flex items-center">
              <ControlButton
                label={muted ? "Unmute" : "Mute"}
                icon={VolumeIcon}
                onClick={toggleMute}
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
            <div className="ms-auto">
              <ControlButton
                label={fullscreen ? "Exit full screen" : "Full screen"}
                icon={fullscreen ? Minimize : Maximize}
                onClick={toggleFullscreen}
              />
            </div>
          </div>
        </div>
      </div>
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
              {state.buffering && state.bufferPercent > 0 && (
                <p className="font-mono text-xs text-white/70 tabular-nums">
                  Buffering {state.bufferPercent} %
                </p>
              )}
              {torrentStatus?.active && (
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

const same = (a: boolean, b: boolean) => a === b;
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

function ControlButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  fill,
  badge,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  fill?: boolean;
  badge?: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="relative rounded-full text-white hover:bg-white/15 hover:text-white"
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
