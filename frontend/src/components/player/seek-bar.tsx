import { Slider } from "@base-ui/react/slider";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { segmentNames, type Segment } from "@/lib/markers";
import { formatTime } from "@/lib/player";
import { cn } from "@/lib/utils";

// The seek bar: what's played (white), what's buffered ahead of it (a
// fainter white), and the time under the pointer. The intro, recap and
// credits never touch the progress itself: they are short amber dashes in a
// lane of their own above the track, so "played" and "skippable" can't be
// mistaken for each other, and the hover label names the one under the
// pointer. Dragging scrubs (keyframe seeks, so the picture keeps up) and
// lands exactly when let go; arrow keys step a second, Page Up and Down ten.
// Between the ~4 a second time events the played part glides on, so it moves
// smoothly. The track is 4 px and grows to 8 px under the pointer or a drag;
// the thumb only shows then, or on keyboard focus.
export function SeekBar({
  position,
  duration,
  buffered,
  segments,
  playing,
  onScrub,
  onSeek,
  onDraggingChange,
}: {
  position: number;
  duration: number;
  // Seconds of cache ahead of position.
  buffered: number;
  // What there is to skip (skipSegments): marked on the track.
  segments: readonly Segment[];
  playing: boolean;
  onScrub: (position: number) => void;
  onSeek: (position: number) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const [drag, setDrag] = useState<number>();
  const dragging = useRef<number>(undefined);
  const [hover, setHover] = useState<number>();
  const known = duration > 0;
  const at = drag ?? Math.min(position, duration);
  const percent = (seconds: number) => (known ? (Math.min(seconds, duration) / duration) * 100 : 0);
  const pointerAt = (event: PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return 0;
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration;
  };
  const label = drag ?? hover;
  const labelSegment =
    label === undefined
      ? undefined
      : segments.find((segment) => label >= segment.start && label < segment.end);
  const start = (value: number) => {
    if (dragging.current === undefined) onDraggingChange(true);
    dragging.current = value;
    setDrag(value);
    onScrub(value);
  };
  const finish = (value: number) => {
    if (dragging.current !== undefined) onDraggingChange(false);
    dragging.current = undefined;
    setDrag(undefined);
    onSeek(value);
  };
  // Base UI commits nothing when a drag ends where it began: end it on the
  // pointer's release anyway, after the commit had its turn.
  useEffect(() => {
    if (drag === undefined) return undefined;
    const release = () =>
      setTimeout(() => {
        if (dragging.current !== undefined) finish(dragging.current);
      });
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  });

  return (
    <Slider.Root
      value={known ? at : 0}
      min={0}
      max={known ? duration : 1}
      disabled={!known}
      onValueChange={(value, { reason }) => {
        if (reason === "drag" || reason === "track-press") start(value);
      }}
      onValueCommitted={finish}
      className="group/seek w-full"
    >
      <Slider.Control
        data-testid="seek-bar"
        className="relative flex h-7 cursor-pointer touch-none items-center pt-1.5 select-none data-disabled:cursor-default"
        onPointerMove={(event) => known && setHover(pointerAt(event))}
        onPointerLeave={() => setHover(undefined)}
      >
        {known && label !== undefined && (
          <span
            aria-hidden
            style={{ left: `${percent(label)}%` }}
            className="pointer-events-none absolute bottom-full mb-5 flex -translate-x-1/2 flex-col items-center gap-0.5 rounded-xl bg-black/80 px-2.5 py-1.5 text-white shadow-float backdrop-blur-md"
          >
            {labelSegment && (
              <span className="type-eyebrow text-[0.625rem] text-[#ffc46b]">
                {segmentNames[labelSegment.kind] ?? labelSegment.kind}
              </span>
            )}
            <span className="text-small font-semibold tnum">{formatTime(label)}</span>
          </span>
        )}
        {/* The chapters lane: above the track, apart from the progress. */}
        {known && segments.length > 0 && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1">
            {segments.map((segment) => (
              <div
                key={`${segment.kind}-${segment.start}`}
                data-testid="segment"
                data-kind={segment.kind}
                style={{
                  left: `${percent(segment.start)}%`,
                  width: `max(4px, ${percent(segment.end) - percent(segment.start)}%)`,
                }}
                className={cn(
                  "absolute inset-y-0 rounded-full bg-[#ffb547] transition-opacity",
                  labelSegment === segment ? "opacity-100" : "opacity-75",
                )}
              />
            ))}
          </div>
        )}
        <Slider.Track className="relative h-1 w-full rounded-full bg-white/18 transition-[height] duration-300 ease-bounce motion-reduce:transition-none group-hover/seek:h-2 group-data-dragging/seek:h-2">
          <div
            data-testid="buffered"
            style={{
              left: `${percent(at)}%`,
              width: `${Math.max(0, percent(at + buffered) - percent(at))}%`,
            }}
            className={cn(
              "absolute inset-y-0 rounded-full bg-white/30",
              smooth(playing && drag === undefined),
            )}
          />
          <Slider.Indicator
            className={cn("rounded-full bg-white", smooth(playing && drag === undefined))}
          />
          <Slider.Thumb
            aria-label="Seek"
            getAriaValueText={(_, value) => `${formatTime(value)} of ${formatTime(duration)}`}
            className={cn(
              "size-4 rounded-full bg-white opacity-0 shadow-[0_0_0_4px_rgb(255_255_255/0.18),0_2px_8px_rgb(0_0_0/0.5)] outline-none transition-opacity group-hover/seek:opacity-100 group-data-dragging/seek:opacity-100 has-focus-visible:opacity-100 has-focus-visible:ring-2 has-focus-visible:ring-white/60",
              smooth(playing && drag === undefined),
            )}
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

// Glides between time events (250 ms apart) while playing.
const smooth = (on: boolean) =>
  on && "transition-[left,width,inset-inline-start,opacity,height] duration-250 ease-linear";
