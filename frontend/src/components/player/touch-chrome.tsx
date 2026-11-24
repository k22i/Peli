import {
  Activity,
  Keyboard,
  Captions,
  Check,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Eye,
  FastForward,
  Gauge,
  LifeBuoy,
  Lock,
  Minus,
  Moon,
  Plus,
  SlidersHorizontal,
  Sun,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { sheetSurface } from "@/components/player/panel-controls";
import { PreviewFrame } from "@/components/player/preview-frame";
import {
  PlayerMenu,
  PlayerMenuCheckboxItem,
  PlayerMenuItem,
  PlayerMenuRadioGroup,
  PlayerMenuRadioItem,
  PlayerMenuSeparator,
  PlayerSubmenu,
} from "@/components/player/player-menu";
import type { SleepProps } from "@/components/player/more-menu";
import { Spinner } from "@/components/ui/spinner";
import type { Meta } from "@/lib/addon-protocol";
import { formatTime, subtitleDelayText, trackLabel, type Track } from "@/lib/player";
import type { PreviewImage } from "@/lib/previews";
import { sleepChoices } from "@/lib/sleep-timer";
import { normalSpeed, sameSpeed, speedLabel, speeds } from "@/lib/speed";
import { byLanguage, syncSummary, type AddonSubtitle, type SubtitleSync } from "@/lib/subtitles";
import {
  episodeCode,
  episodes as episodesOf,
  seasonLabel,
  seasons as seasonsOf,
  titleProgressQuery,
  titleState,
  titleWatchedQuery,
  type Episode,
} from "@/lib/title";
import { useSpoilers } from "@/lib/spoilers";
import { cn } from "@/lib/utils";

// The touch player's chrome (#130), after YouTube, Netflix and Infuse: a
// small top row, the transport in the middle of the picture, a thin seek row
// and, for a series, one row of text buttons under it. These are its pieces;
// player-page.tsx lays them out and owns the state. Desktop and the mini
// player don't use any of this.

// How much of the bottom the touch chrome covers, in rem, with a gap above
// it: the seek row (2 rem) and, for a series, the bottom row (2 rem), over
// the home indicator's inset (about 1.3 rem on an iPhone on its side).
export const touchChromeRem = { movie: 2 + 1.3 + 0.7, series: 4 + 1.3 + 0.7 };

// A round glass button over the picture: Back's chevron has no disc, the
// skips are 48 pt, Play 64 pt.
export function GlassButton({
  label,
  size = "md",
  bare = false,
  className,
  children,
  ...props
}: {
  label: string;
  size?: "md" | "skip" | "play";
  // No disc: the chevron of Back, the icons of the top row.
  bare?: boolean;
  children: ReactNode;
} & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full text-white outline-none transition-[scale,opacity,background-color] focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-40 motion-safe:active:scale-90",
        size === "md" && "size-11 [&_svg]:size-5.5",
        size === "skip" && "size-12 [&_svg]:size-6",
        size === "play" && "size-16 [&_svg]:size-7",
        !bare && "material-media",
        bare && "drop-shadow-[0_1px_6px_rgb(0_0_0/0.55)] active:bg-white/12",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// The top row, 44 pt: Back (a chevron, no disc) and what plays on one line
// on the left; Watch party, Audio & Subtitles, Lock and More on the right.
// Lock shows only when the page passes onLock (#131 adds it).
export function TouchTopRow({
  title,
  episode,
  onBack,
  tracks,
  party,
  onLock,
  more,
  className,
  ...hold
}: {
  title: string | undefined;
  episode: string | undefined;
  onBack: () => void;
  // The Audio & Subtitles button, when there's something to pick.
  tracks?: { open: boolean; on: boolean; onOpen: () => void } | undefined;
  // The watch party (ADR-0063): the sheet the desktop's W key opens, while
  // something plays or this device is already in a party.
  party?: { open: boolean; inParty: boolean; unread: boolean; onOpen: () => void } | undefined;
  onLock?: (() => void) | undefined;
  more?: ReactNode;
  className?: string | false | undefined;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <div
      {...hold}
      data-testid="top-row"
      className={cn(
        "absolute inset-x-0 top-0 flex h-[calc(2.75rem+0.75rem+env(safe-area-inset-top))] items-end gap-1 ps-[calc(0.25rem+env(safe-area-inset-left))] pe-[calc(0.25rem+env(safe-area-inset-right))] transition-opacity duration-200",
        className,
      )}
    >
      <GlassButton label="Back" bare onClick={onBack}>
        <ChevronLeft className="size-7!" />
      </GlassButton>
      {title && (
        <div className="flex h-11 min-w-0 flex-1 items-center gap-1.5 drop-shadow-[0_1px_8px_rgb(0_0_0/0.6)]">
          <h1 className="max-w-[60%] shrink-0 truncate text-[0.9375rem] font-[650]">{title}</h1>
          {episode && (
            <p className="min-w-0 truncate text-[0.8125rem] text-white/70">
              <span aria-hidden>· </span>
              {episode}
            </p>
          )}
        </div>
      )}
      <div className="ms-auto flex shrink-0 items-center">
        {party && (
          <GlassButton
            label="Watch party"
            bare
            aria-expanded={party.open}
            onClick={party.onOpen}
            className={cn(party.inParty && "bg-white/12")}
          >
            <Users />
            {party.unread && (
              <span
                aria-hidden
                className="absolute top-2 right-2 size-1.5 rounded-full bg-[#ffb547]"
              />
            )}
          </GlassButton>
        )}
        {tracks && (
          <GlassButton
            label="Audio and subtitles"
            bare
            aria-expanded={tracks.open}
            aria-keyshortcuts="V"
            onClick={tracks.onOpen}
          >
            <Captions />
            {tracks.on && !tracks.open && (
              <span
                aria-hidden
                className="absolute top-2 right-2 size-1.5 rounded-full bg-[#ffb547]"
              />
            )}
          </GlassButton>
        )}
        {onLock && (
          <GlassButton label="Lock the controls" bare onClick={onLock}>
            <Lock />
          </GlassButton>
        )}
        {more}
      </div>
    </div>
  );
}

// A text and icon button of the bottom row (Netflix's): 13 pt, 32 pt tall.
export function RowButton({
  icon,
  children,
  className,
  ...props
}: { icon: ReactNode; children: ReactNode } & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[0.8125rem] font-[600] text-white outline-none drop-shadow-[0_1px_6px_rgb(0_0_0/0.55)] transition-[background-color,scale] focus-visible:ring-2 focus-visible:ring-white/70 active:bg-white/12 motion-safe:active:scale-95 [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

// The bottom row's Speed: "1× Speed", opening the speeds above it.
export function TouchSpeedMenu({
  speed,
  onChange,
  open,
  onOpenChange,
}: {
  speed: number;
  onChange: (speed: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const picked = speeds.find((each) => sameSpeed(each, speed)) ?? speed;
  const shown = speedLabel(sameSpeed(speed, normalSpeed) ? normalSpeed : speed);
  return (
    <PlayerMenu
      label={`Playback speed, ${speedLabel(speed)}`}
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      triggerClassName="flex h-8 gap-1.5 px-2.5 text-[0.8125rem] font-[600] drop-shadow-[0_1px_6px_rgb(0_0_0/0.55)] [&_svg]:size-4"
      trigger={
        <span className="flex items-center gap-1.5">
          <Gauge aria-hidden />
          <span className="tnum">{shown}</span> Speed
        </span>
      }
    >
      <SpeedItems picked={picked} onChange={onChange} />
    </PlayerMenu>
  );
}

function SpeedItems({ picked, onChange }: { picked: number; onChange: (speed: number) => void }) {
  return (
    <PlayerMenuRadioGroup label="Playback speed" value={picked} onChange={onChange}>
      {speeds.toReversed().map((each) => (
        <PlayerMenuRadioItem
          key={each}
          value={each}
          hint={each === normalSpeed ? "Normal" : undefined}
        >
          {speedLabel(each)}
        </PlayerMenuRadioItem>
      ))}
    </PlayerMenuRadioGroup>
  );
}

// The top row's More (•••): the Picture & sound sheet, Speed when there's no
// bottom row for it, the sleep timer and the playback stats. "Report a
// problem" (#127's Share logs) joins it once that's built.
export function TouchMoreMenu({
  open,
  onOpenChange,
  speed,
  sleep,
  stats,
  onPicture,
  shortcuts,
  onReport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Speed, when the bottom row doesn't show it.
  speed?: { speed: number; onChange: (speed: number) => void } | undefined;
  sleep: SleepProps;
  stats: { open: boolean; onToggle: () => void };
  // "Picture and sound": the sheet the desktop dock has its own button for.
  onPicture?: (() => void) | undefined;
  // "Keyboard shortcuts": the list (shortcuts.tsx), while an iPad has a
  // hardware keyboard attached (#138). iPadOS's own ⌘-hold list only shows
  // UIKeyCommands, and Peli's keys live in the webview.
  shortcuts?: { open: boolean; onToggle: () => void } | undefined;
  // "Report a problem": shares the logs (#127), on iOS.
  onReport?: (() => void) | undefined;
}) {
  const picked = speed && (speeds.find((each) => sameSpeed(each, speed.speed)) ?? speed.speed);
  return (
    <PlayerMenu
      label="More"
      open={open}
      onOpenChange={onOpenChange}
      side="bottom"
      lit={sleep.choice !== "off"}
      triggerClassName="size-11 drop-shadow-[0_1px_6px_rgb(0_0_0/0.55)] [&_svg]:size-5.5"
      trigger={<Ellipsis />}
    >
      {speed && picked !== undefined && (
        <>
          <PlayerSubmenu
            icon={<Gauge aria-hidden />}
            label="Speed"
            hint={speedLabel(sameSpeed(speed.speed, normalSpeed) ? normalSpeed : speed.speed)}
          >
            <SpeedItems picked={picked} onChange={speed.onChange} />
          </PlayerSubmenu>
          <PlayerMenuSeparator />
        </>
      )}
      {onPicture && (
        <PlayerMenuItem icon={<SlidersHorizontal aria-hidden />} onClick={onPicture}>
          Picture and sound
        </PlayerMenuItem>
      )}
      <PlayerSubmenu icon={<Moon aria-hidden />} label="Sleep timer" hint={sleep.hint ?? "Off"}>
        <PlayerMenuRadioGroup label="Sleep timer" value={sleep.choice} onChange={sleep.onChange}>
          {sleepChoices
            .filter((each) => each.value !== "episode" || sleep.episodeKnown)
            .map((each) => (
              <PlayerMenuRadioItem key={each.value} value={each.value}>
                {each.name}
              </PlayerMenuRadioItem>
            ))}
        </PlayerMenuRadioGroup>
      </PlayerSubmenu>
      <PlayerMenuCheckboxItem checked={stats.open} onChange={stats.onToggle}>
        <span className="flex items-center gap-3">
          <Activity aria-hidden className="size-4.5" />
          Playback stats
        </span>
      </PlayerMenuCheckboxItem>
      {shortcuts && (
        <PlayerMenuCheckboxItem checked={shortcuts.open} onChange={shortcuts.onToggle}>
          <span className="flex items-center gap-3">
            <Keyboard aria-hidden className="size-4.5" />
            Keyboard shortcuts
          </span>
        </PlayerMenuCheckboxItem>
      )}
      {onReport && (
        <PlayerMenuItem icon={<LifeBuoy aria-hidden />} onClick={onReport}>
          Report a problem
        </PlayerMenuItem>
      )}
    </PlayerMenu>
  );
}

// The level HUD of a brightness or volume swipe (#131, Netflix's): a thin
// vertical capsule 32 pt inside the safe edge on the side being changed,
// with the icon above and the percentage below. The page shows it at once
// and fades it 600 ms after the finger lifts. Volume changes from the
// hardware buttons show here too, and are read out (role=status).
export function LevelHud({
  side,
  value,
  shown,
}: {
  side: "brightness" | "volume";
  value: number;
  shown: boolean;
}) {
  const percent = Math.round(value * 100);
  const Icon = side === "brightness" ? Sun : percent === 0 ? VolumeX : Volume2;
  return (
    <div
      data-testid="level-hud"
      className={cn(
        "pointer-events-none absolute top-1/2 flex -translate-y-1/2 flex-col items-center gap-2.5 text-white drop-shadow-[0_1px_8px_rgb(0_0_0/0.55)]",
        side === "brightness"
          ? "start-[calc(2rem+env(safe-area-inset-left))]"
          : "end-[calc(2rem+env(safe-area-inset-right))]",
        shown ? "opacity-100" : "opacity-0 transition-opacity duration-300",
      )}
    >
      <Icon aria-hidden className="size-5" />
      <div className="material-media relative h-35 w-2 overflow-hidden rounded-full">
        <div
          className="absolute inset-x-0 bottom-0 rounded-full bg-white"
          style={{ height: `${percent}%` }}
        />
      </div>
      {side === "volume" ? (
        <output className="text-xs font-[600] tnum">
          <span className="sr-only">Volume </span>
          {percent} %
        </output>
      ) : (
        <p className="text-xs font-[600] tnum">{percent} %</p>
      )}
    </div>
  );
}

// A double tap's skip (YouTube's): an arc from that side with the running
// total.
export function SkipRipple({ side, seconds }: { side: -1 | 1; seconds: number }) {
  return (
    <div
      aria-hidden
      data-testid="skip-ripple"
      className={cn(
        "pointer-events-none absolute inset-y-0 grid w-[38%] place-items-center bg-white/10 motion-safe:animate-in motion-safe:fade-in-0",
        side < 0 ? "start-0 rounded-e-[50%]" : "end-0 rounded-s-[50%]",
      )}
    >
      <p className="flex items-center gap-1.5 text-[0.9375rem] font-[650] text-white drop-shadow-[0_1px_8px_rgb(0_0_0/0.6)]">
        {side < 0 && <FastForward aria-hidden className="size-4.5 rotate-180 fill-current" />}
        {seconds} seconds
        {side > 0 && <FastForward aria-hidden className="size-4.5 fill-current" />}
      </p>
    </div>
  );
}

// While a hold plays at 2×: a pill at the top centre.
export function HoldPill() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[calc(1rem+env(safe-area-inset-top))] flex justify-center">
      <output className="material-media flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[0.8125rem] font-[650] text-white">
        2× <FastForward aria-hidden className="size-3.5 fill-current" />
      </output>
    </div>
  );
}

// The locked player's only control: a pill that a 1 s hold unlocks. The
// page shows it for 2 s after a tap.
export function LockPill({ shown, onUnlock }: { shown: boolean; onUnlock: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [holding, setHolding] = useState(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const release = () => {
    clearTimeout(timer.current);
    setHolding(false);
  };
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] flex justify-center transition-opacity duration-200",
        shown ? "opacity-100 *:pointer-events-auto" : "opacity-0",
      )}
    >
      <button
        type="button"
        data-testid="lock-pill"
        aria-label="Controls locked. Hold to unlock"
        className="material-media relative flex h-11 items-center gap-2 overflow-hidden rounded-full px-4 text-[0.8125rem] font-[600] text-white outline-none select-none [-webkit-touch-callout:none]"
        onPointerDown={(event) => {
          event.stopPropagation();
          setHolding(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            setHolding(false);
            onUnlock();
          }, 1000);
        }}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          // A keyboard (or switch control) unlocks with Enter or Space.
          if (event.key === "Enter" || event.key === " ") onUnlock();
        }}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 start-0 bg-white/20",
            holding ? "w-full transition-[width] duration-1000 ease-linear" : "w-0",
          )}
        />
        <Lock aria-hidden className="relative size-4" />
        <span className="relative">Controls locked · Hold to unlock</span>
      </button>
    </div>
  );
}

// While scrubbing (a drag on the bar, or #131's swipe): the time it goes to,
// large at the centre, and how far that is from where it was.
export function ScrubLabel({
  from,
  to,
  thumb,
}: {
  from: number;
  to: number;
  // The nearest seek preview already made (lib/previews), over the big time.
  thumb?: PreviewImage | undefined;
}) {
  const delta = Math.round(to) - Math.round(from);
  return (
    <div
      aria-hidden
      data-testid="scrub-label"
      className="pointer-events-none absolute inset-0 grid place-items-center"
    >
      <div className="flex flex-col items-center gap-1 drop-shadow-[0_2px_16px_rgb(0_0_0/0.7)]">
        {thumb && (
          <PreviewFrame
            preview={thumb}
            testId="scrub-thumb"
            className="mb-2 w-56 rounded-2xl shadow-float"
          />
        )}
        <p className="text-[2.75rem] leading-none font-[650] text-white tnum">{formatTime(to)}</p>
        <p className="text-[0.9375rem] font-[600] text-white/80 tnum">
          {delta < 0 ? "−" : "+"}
          {formatTime(Math.abs(delta))}
        </p>
      </div>
    </div>
  );
}

// A side sheet over the picture, from the right: full height inside the
// safe area, on the strong media glass.
function SideSheet({
  label,
  onClose,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const sheet = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      sheet.current
        ?.querySelector<HTMLElement>("[aria-pressed=true], button")
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <dialog
      ref={sheet}
      open
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "dark absolute start-auto end-[calc(0.5rem+env(safe-area-inset-right))] top-[calc(0.5rem+env(safe-area-inset-top))] bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-20 m-0 flex h-auto max-h-none w-[min(22.5rem,calc(100%-1rem))] max-w-none flex-col overflow-hidden rounded-[1.5rem] border-0 p-0 text-white",
        sheetSurface,
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-6 motion-safe:duration-300",
        className,
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 ps-4 pe-1.5">
        <h2 className="min-w-0 flex-1 truncate text-[0.9375rem] font-[650]">{label}</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid size-11 shrink-0 place-items-center rounded-full text-white/75 outline-none active:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4.5"
        >
          <X />
        </button>
      </header>
      {children}
    </dialog>
  );
}

// A plain list row with a checkmark (Netflix's).
function CheckRow({
  selected,
  loading = false,
  onPick,
  title,
  detail,
}: {
  selected: boolean;
  loading?: boolean;
  onPick: () => void;
  title: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        "flex min-h-11 w-full items-center gap-2 rounded-xl px-1.5 py-1.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring active:bg-white/8",
        selected ? "text-white" : "text-white/75",
      )}
    >
      <span aria-hidden className="grid size-4 shrink-0 place-items-center">
        {selected && <Check className="size-4" strokeWidth={3} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("text-[0.8125rem] leading-snug", selected ? "font-[650]" : "font-[520]")}
        >
          {title}
        </span>
        {detail && <span className="truncate text-[0.6875rem] text-white/50">{detail}</span>}
      </span>
      {loading && <Spinner className="size-3.5 shrink-0 text-white/60" />}
    </button>
  );
}

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <h3 className="shrink-0 px-3 pb-1 text-[0.6875rem] font-[700] tracking-[0.08em] text-white/55 uppercase">
        {title}
      </h3>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3">
        {children}
      </div>
    </section>
  );
}

// The touch player's Audio & Subtitles sheet (#130): two plain lists side by
// side. Subtitles lists the file's own, then the addons' by language, as the
// desktop panel's submenus do; under it, Subtitle style… (the panel's Style
// tab) and Timing… (the Z/X delay as − and +).
export function TracksSheet({
  onClose,
  audioTracks,
  audioId,
  onPickAudio,
  subtitleTracks,
  addedIds,
  subtitleId,
  onPickTrack,
  addonSubtitles,
  addonLoading,
  addonKey,
  loadingKey,
  onPickAddon,
  preferredLanguage,
  delay,
  onDelayChange,
  onStyle,
  sync,
  onOriginalTiming,
}: {
  onClose: () => void;
  audioTracks: Track[];
  audioId: number;
  onPickAudio: (id: number) => void;
  subtitleTracks: Track[];
  addedIds: ReadonlySet<number>;
  subtitleId: number;
  onPickTrack: (id: number) => void;
  addonSubtitles: AddonSubtitle[];
  addonLoading: boolean;
  addonKey: string | undefined;
  loadingKey: string | undefined;
  onPickAddon: (subtitle: AddonSubtitle) => void;
  preferredLanguage: string;
  delay: number;
  // A step of the timing: −0.1 or +0.1 s.
  onDelayChange: (by: number) => void;
  onStyle: () => void;
  // How the addon subtitles showing were lined up with the video.
  sync?: SubtitleSync | undefined;
  onOriginalTiming?: (() => void) | undefined;
}) {
  const [timing, setTiming] = useState(false);
  const summary = syncSummary(sync);
  const fileTracks = subtitleTracks.filter((track) => !addedIds.has(track.id));
  const groups = byLanguage(addonSubtitles, preferredLanguage);
  const hasSubtitles = subtitleTracks.length > 0 || addonSubtitles.length > 0 || addonLoading;
  return (
    <SideSheet label="Audio and subtitles" onClose={onClose}>
      <div className="flex min-h-0 flex-1 gap-1">
        {audioTracks.length > 0 && (
          <Column title="Audio">
            {audioTracks.map((track) => {
              const { name, detail } = trackLabel(track);
              return (
                <CheckRow
                  key={track.id}
                  selected={track.id === audioId}
                  onPick={() => onPickAudio(track.id)}
                  title={name}
                  detail={detail}
                />
              );
            })}
          </Column>
        )}
        {hasSubtitles && (
          <Column title="Subtitles">
            <CheckRow selected={subtitleId === 0} onPick={() => onPickTrack(0)} title="Off" />
            {fileTracks.map((track) => {
              const { name, detail } = trackLabel(track);
              return (
                <CheckRow
                  key={track.id}
                  selected={!addonKey && track.id === subtitleId}
                  onPick={() => onPickTrack(track.id)}
                  title={name}
                  detail={detail}
                />
              );
            })}
            {groups.map((group) => (
              <fieldset key={group.language} className="m-0 min-w-0 border-0 p-0">
                <legend className="px-1.5 pt-2.5 pb-0.5 text-[0.6875rem] font-[650] text-white/50">
                  {group.label}
                </legend>
                {group.subtitles.map((subtitle, index) => (
                  <CheckRow
                    key={subtitle.key}
                    selected={addonKey === subtitle.key}
                    loading={loadingKey === subtitle.key}
                    onPick={() => onPickAddon(subtitle)}
                    title={subtitle.name || `${group.label} ${index + 1}`}
                    detail={
                      addonKey === subtitle.key && summary?.synced
                        ? `Synced · ${subtitle.addon}`
                        : subtitle.addon
                    }
                  />
                ))}
              </fieldset>
            ))}
            {addonLoading && (
              <p className="flex items-center gap-2 px-1.5 pt-3 text-[0.75rem] text-white/55">
                <Spinner className="size-3" />
                Asking your addons…
              </p>
            )}
          </Column>
        )}
      </div>
      {subtitleTracks.length > 0 && (
        <footer className="flex shrink-0 flex-col gap-1 border-t border-white/10 p-2">
          <SheetLink onClick={onStyle}>Subtitle style…</SheetLink>
          <SheetLink onClick={() => setTiming(!timing)} expanded={timing}>
            Timing…
            <span className="ms-auto text-white/55 tnum">{subtitleDelayText(delay)}</span>
          </SheetLink>
          {timing && (
            <fieldset className="m-0 flex min-w-0 items-center gap-2 border-0 px-1 py-0">
              <legend className="sr-only">Subtitle timing</legend>
              <GlassButton label="Earlier" bare onClick={() => onDelayChange(-0.1)}>
                <Minus />
              </GlassButton>
              <p className="flex-1 text-center text-[0.8125rem] font-[600] tnum">
                {subtitleDelayText(delay)}
              </p>
              <GlassButton label="Later" bare onClick={() => onDelayChange(0.1)}>
                <Plus />
              </GlassButton>
            </fieldset>
          )}
          {timing && summary && (
            <div className="flex flex-col gap-1 px-2.5 pb-1">
              <p className="text-[0.75rem] font-[650] text-white">{summary.title}</p>
              <p className="text-[0.6875rem] leading-snug text-white/55">{summary.detail}</p>
              {summary.synced && onOriginalTiming && (
                <button
                  type="button"
                  onClick={onOriginalTiming}
                  className="mt-1 flex h-9 items-center self-start rounded-full bg-white/10 px-3 text-[0.75rem] font-[620] text-white outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-white/16"
                >
                  Use original timing
                </button>
              )}
            </div>
          )}
        </footer>
      )}
    </SideSheet>
  );
}

function SheetLink({
  onClick,
  expanded,
  children,
}: {
  onClick: () => void;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="flex h-11 items-center gap-2 rounded-xl px-2.5 text-[0.8125rem] font-[600] text-white outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-white/8"
    >
      {children}
      {expanded === undefined && (
        <ChevronRight aria-hidden className="ms-auto size-4 text-white/50" />
      )}
    </button>
  );
}

// The Episodes sheet (#130): the season playing, its episodes in order, and
// the other seasons a tap away. Picking one goes through the stream picker,
// as the next episode does when there's no stream ready.
export function EpisodesSheet({
  profileId,
  meta,
  playing,
  onPick,
  onClose,
}: {
  profileId: number;
  meta: Meta;
  // The episode playing's id.
  playing: string;
  onPick: (episode: Episode) => void;
  onClose: () => void;
}) {
  const list = episodesOf(meta);
  const all = seasonsOf(list);
  const current = list.find((episode) => episode.id === playing);
  const [season, setSeason] = useState(current?.season ?? all[0] ?? 1);
  const shown = list.filter((episode) => episode.season === season);
  // Spoiler protection: stills of episodes not watched or started are
  // blurred; one button reveals the season's.
  const spoilers = useSpoilers(profileId);
  const marks = useQuery(titleWatchedQuery(profileId, meta.id)).data ?? [];
  const progress = useQuery(titleProgressQuery(profileId, meta.id)).data ?? [];
  const state = titleState(meta, marks, progress);
  const hidden = (episode: Episode) =>
    episode.id !== playing &&
    spoilers.hidden(episode.id, state.watched(episode), state.progress(episode) !== undefined);
  const hiddenShown = shown.filter((episode) => episode.thumbnail && hidden(episode));
  return (
    <SideSheet label="Episodes" onClose={onClose} className="w-[min(24rem,calc(100%-1rem))]">
      {all.length > 1 && (
        <fieldset className="no-scrollbar m-0 flex min-w-0 shrink-0 gap-1.5 overflow-x-auto border-0 px-3 pt-0 pb-2">
          <legend className="sr-only">Seasons</legend>
          {all.map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={each === season}
              onClick={() => setSeason(each)}
              className={cn(
                "h-8 shrink-0 rounded-full px-3 text-[0.8125rem] font-[600] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
                each === season ? "bg-white text-black" : "bg-white/10 text-white/80",
              )}
            >
              {seasonLabel(each)}
            </button>
          ))}
        </fieldset>
      )}
      {hiddenShown.length > 0 && (
        <div className="flex shrink-0 justify-end px-3 pb-1">
          <button
            type="button"
            onClick={() => {
              for (const episode of hiddenShown) spoilers.reveal(episode.id);
            }}
            className="flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[0.8125rem] font-[600] text-white/80 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Eye aria-hidden className="size-4" />
            Reveal pictures
          </button>
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {shown.map((episode) => {
          const now = episode.id === playing;
          return (
            <li key={episode.id}>
              <button
                type="button"
                aria-current={now || undefined}
                onClick={() => (now ? onClose() : onPick(episode))}
                className="flex w-full items-center gap-3 rounded-xl p-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-white/8"
              >
                <span className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-white/8">
                  {episode.thumbnail && (
                    <img
                      decoding="async"
                      src={episode.thumbnail}
                      alt=""
                      loading="lazy"
                      className={cn(
                        "absolute inset-0 size-full object-cover",
                        hidden(episode) && "scale-110 blur-lg",
                      )}
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                    />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[0.6875rem] font-[650] text-white/55 tnum">
                    {episodeCode(episode)}
                    {now && <span className="ms-1.5 text-[#ffc46b]">Playing</span>}
                  </span>
                  <span className="line-clamp-2 text-[0.8125rem] leading-snug font-[600]">
                    {episode.title || `Episode ${episode.episode}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </SideSheet>
  );
}
