import { Slider } from "@base-ui/react/slider";
import { Minus, Plus, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// The controls of the player's sheets (the subtitle panel, Picture & sound):
// white on the warm dark glass, each with a visible focus ring.

export function Field({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="type-eyebrow text-white/55">{label}</span>
        {value && <span className="text-small font-[590] text-white/80 tnum">{value}</span>}
      </div>
      {children}
    </div>
  );
}

export function Segmented({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; name: string; family?: string | undefined }[];
}) {
  return (
    <div aria-label={label} className="flex gap-1 rounded-2xl bg-white/7 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          style={option.family ? { fontFamily: option.family } : undefined}
          className={cn(
            "h-9 flex-1 rounded-xl text-[0.875rem] font-[560] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            value === option.value
              ? "bg-white text-black shadow-[0_2px_8px_rgb(0_0_0/0.3)]"
              : "text-white/70 hover:text-white",
          )}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

export function PanelSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  onActive,
  center = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  // A drag let go or a key press: the value to keep.
  onCommit?: (value: number) => void;
  // A drag starts (true) and ends (false), for a live preview. A drag that
  // ends where it began commits nothing, so the end is the pointer's.
  onActive?: (active: boolean) => void;
  // Fill from the middle (a value that can go either way).
  center?: boolean;
}) {
  const percent = ((value - min) / (max - min)) * 100;
  const middle = ((0 - min) / (max - min)) * 100;
  return (
    <Slider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => onChange(next)}
      onValueCommitted={(next) => onCommit?.(next)}
      className="w-full"
    >
      <Slider.Control
        onPointerDown={() => {
          if (!onActive) return;
          onActive(true);
          window.addEventListener("pointerup", () => onActive(false), { once: true });
        }}
        className="relative flex h-6 cursor-pointer touch-none items-center select-none"
      >
        <Slider.Track className="relative h-1.5 w-full rounded-full bg-white/14">
          {center ? (
            <>
              <div
                aria-hidden
                className="absolute inset-y-0 rounded-full bg-sun"
                style={{
                  left: `${Math.min(percent, middle)}%`,
                  width: `${Math.abs(percent - middle)}%`,
                }}
              />
              <div
                aria-hidden
                className="absolute -inset-y-1.5 w-px bg-white/40"
                style={{ left: `${middle}%` }}
              />
            </>
          ) : (
            <Slider.Indicator className="rounded-full bg-white" />
          )}
          <Slider.Thumb
            aria-label={label}
            className="size-4.5 rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.5)] outline-none has-focus-visible:ring-2 has-focus-visible:ring-ring"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

export function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <RoundStep
        label={`Smaller ${label.toLowerCase()}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - step * 2))}
      >
        <Minus />
      </RoundStep>
      <div className="flex-1">
        <PanelSlider
          label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onChange}
        />
      </div>
      <RoundStep
        label={`Larger ${label.toLowerCase()}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + step * 2))}
      >
        <Plus />
      </RoundStep>
    </div>
  );
}

export function RoundStep({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-full bg-white/8 text-white outline-none transition-[background-color,scale] hover:bg-white/14 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 motion-safe:active:scale-90 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-4 px-4 py-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[0.875rem] font-[580]">{label}</span>
        {hint && <span className="text-tiny leading-snug text-white/50">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "relative h-6 w-10 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
          checked ? "bg-sun" : "bg-white/20",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] duration-200",
            checked ? "left-[calc(100%-1.375rem)]" : "left-0.5",
          )}
        />
      </span>
    </label>
  );
}

// The sheet's surface, the subtitle panel's: warm near-black glass on the
// right. While a slider is dragged it gives way to the picture
// (`previewing`): only that slider's row stays, on its own pill.
export const sheetSurface =
  "bg-[rgb(18_16_14/0.86)] shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] ring-1 ring-white/10 backdrop-blur-3xl backdrop-saturate-150 reduced-transparency:bg-[rgb(18_16_14)] reduced-transparency:backdrop-blur-none";

// What a tab knows of the sheet's live preview: which row is being dragged
// (the others hide), and how to say a drag started or ended.
export type Preview = {
  active: string | undefined;
  setActive: (row: string | undefined) => void;
};

// A row's classes while previewing: hidden unless it's the one dragged,
// which sits on its own pill.
export function previewRow(preview: Preview, row?: string): string {
  if (preview.active === undefined) return "";
  return preview.active === row ? cn("-mx-2 rounded-2xl px-2 py-2", sheetSurface) : "invisible";
}

export function SectionHead({
  title,
  reset,
  className,
}: {
  title: string;
  reset: (() => void) | undefined;
  className?: string;
}) {
  return (
    <div className={cn("flex h-8 items-center justify-between", className)}>
      <h3 className="type-eyebrow text-white/55">{title}</h3>
      {reset && (
        <button
          type="button"
          onClick={reset}
          className="flex h-8 items-center gap-1.5 rounded-full px-3 text-small font-[560] text-white/75 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
        >
          <RotateCcw aria-hidden />
          Reset
        </button>
      )}
    </div>
  );
}

export function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset aria-label={label} className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
      {children}
    </fieldset>
  );
}

export function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "h-8 max-w-full truncate rounded-full px-3.5 text-[0.875rem] font-[560] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        pressed
          ? "bg-white text-black"
          : "bg-white/8 text-white/80 hover:bg-white/14 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}
