import { Activity, Check, ChevronRight, Ellipsis, Gauge, Minus, Moon, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { sheetSurface } from "@/components/player/panel-controls";
import {
  PlayerMenu,
  PlayerMenuCheckboxItem,
  PlayerMenuRadioGroup,
  PlayerMenuRadioItem,
  PlayerMenuSeparator,
  PlayerSubmenu,
} from "@/components/player/player-menu";
import type { SleepProps } from "@/components/player/more-menu";
import { Spinner } from "@/components/ui/spinner";
import type { Meta } from "@/lib/addon-protocol";
import { formatTime, subtitleDelayText, trackLabel, type Track } from "@/lib/player";
import { sleepChoices } from "@/lib/sleep-timer";
import { normalSpeed, sameSpeed, speedLabel, speeds } from "@/lib/speed";
import { byLanguage, type AddonSubtitle } from "@/lib/subtitles";
import {
  episodeCode,
  episodes as episodesOf,
  seasonLabel,
  seasons as seasonsOf,
  type Episode,
} from "@/lib/title";
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

// The top row's More (•••): Speed when there's no bottom row for it, the
// sleep timer and the playback stats. "Report a problem" (#127's Share logs)
// joins it once that's built.
export function TouchMoreMenu({
  open,
  onOpenChange,
  speed,
  sleep,
  stats,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Speed, when the bottom row doesn't show it.
  speed?: { speed: number; onChange: (speed: number) => void } | undefined;
  sleep: SleepProps;
  stats: { open: boolean; onToggle: () => void };
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
    </PlayerMenu>
  );
}

// While scrubbing (a drag on the bar, or #131's swipe): the time it goes to,
// large at the centre, and how far that is from where it was.
export function ScrubLabel({ from, to }: { from: number; to: number }) {
  const delta = Math.round(to) - Math.round(from);
  return (
    <div
      aria-hidden
      data-testid="scrub-label"
      className="pointer-events-none absolute inset-0 grid place-items-center"
    >
      <div className="flex flex-col items-center gap-1 drop-shadow-[0_2px_16px_rgb(0_0_0/0.7)]">
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
}) {
  const [timing, setTiming] = useState(false);
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
              <div key={group.language} role="group" aria-label={group.label}>
                <p className="px-1.5 pt-2.5 pb-0.5 text-[0.6875rem] font-[650] text-white/50">
                  {group.label}
                </p>
                {group.subtitles.map((subtitle, index) => (
                  <CheckRow
                    key={subtitle.key}
                    selected={addonKey === subtitle.key}
                    loading={loadingKey === subtitle.key}
                    onPick={() => onPickAddon(subtitle)}
                    title={subtitle.name || `${group.label} ${index + 1}`}
                    detail={subtitle.addon}
                  />
                ))}
              </div>
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
            <div role="group" aria-label="Subtitle timing" className="flex items-center gap-2 px-1">
              <GlassButton label="Earlier" bare onClick={() => onDelayChange(-0.1)}>
                <Minus />
              </GlassButton>
              <p className="flex-1 text-center text-[0.8125rem] font-[600] tnum">
                {subtitleDelayText(delay)}
              </p>
              <GlassButton label="Later" bare onClick={() => onDelayChange(0.1)}>
                <Plus />
              </GlassButton>
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
      {expanded === undefined && <ChevronRight aria-hidden className="ms-auto size-4 text-white/50" />}
    </button>
  );
}

// The Episodes sheet (#130): the season playing, its episodes in order, and
// the other seasons a tap away. Picking one goes through the stream picker,
// as the next episode does when there's no stream ready.
export function EpisodesSheet({
  meta,
  playing,
  onPick,
  onClose,
}: {
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
  return (
    <SideSheet label="Episodes" onClose={onClose} className="w-[min(24rem,calc(100%-1rem))]">
      {all.length > 1 && (
        <div
          role="group"
          aria-label="Seasons"
          className="no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2"
        >
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
                      src={episode.thumbnail}
                      alt=""
                      loading="lazy"
                      className="absolute inset-0 size-full object-cover"
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

