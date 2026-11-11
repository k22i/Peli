import { Slider } from "@base-ui/react/slider";
import { Check, Ear, Eye, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { maxSubtitleDelay, trackLabel } from "@/lib/player";
import { languageLabel, subtitleLanguage, type AddonSubtitle } from "@/lib/subtitles";
import { cn } from "@/lib/utils";
import type { Track } from "@bindings/player";

// How text subtitles look: the profile's, as Go's SubtitleStyle.
export type SubtitleStyle = {
  font: string;
  size: number;
  color: string;
  edge: string;
  backdrop: number;
  lift: number;
  bold: boolean;
  override: boolean;
};

export const defaultSubtitleStyle: SubtitleStyle = {
  font: "sans",
  size: 100,
  color: "#FFFFFF",
  edge: "outline",
  backdrop: 60,
  lift: 0,
  bold: false,
  override: false,
};

export type PanelTab = "subtitles" | "audio" | "style" | "timing";

// One subtitle the user can pick: a track in the file, or an addon's file
// (added to the player when picked).
type Choice =
  | { kind: "track"; key: string; language: string; track: Track }
  | { kind: "addon"; key: string; language: string; subtitle: AddonSubtitle; number: number };

// The player's audio and subtitles, in one panel at the side of the video
//. Subtitles lists every subtitle there is, in the file and from
// addons, in one list grouped by language, with a row of languages to narrow
// it; Audio the file's audio tracks; Style how text subtitles look, with a
// live preview; Timing moves them earlier or later, by a ruler, by steps, or
// by ear: mark when a line is heard and when its subtitle shows, and the
// difference is taken off.
export function SubtitlePanel({
  open,
  tab,
  onTabChange,
  onClose,
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
  audioTracks,
  audioId,
  onPickAudio,
  style,
  onStyleChange,
  delay,
  onDelayChange,
  position,
  subtitleText,
}: {
  open: boolean;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  onClose: () => void;
  subtitleTracks: Track[];
  // Tracks that are addon files already added: listed as the addon's row.
  addedIds: ReadonlySet<number>;
  subtitleId: number;
  onPickTrack: (id: number) => void;
  addonSubtitles: AddonSubtitle[];
  addonLoading: boolean;
  addonKey: string | undefined;
  loadingKey: string | undefined;
  onPickAddon: (subtitle: AddonSubtitle) => void;
  preferredLanguage: string;
  audioTracks: Track[];
  audioId: number;
  onPickAudio: (id: number) => void;
  style: SubtitleStyle;
  onStyleChange: (style: SubtitleStyle) => void;
  delay: number;
  onDelayChange: (delay: number) => void;
  position: number;
  subtitleText: string;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open) return null;

  const tabs: { id: PanelTab; label: string }[] = [
    { id: "subtitles", label: "Subtitles" },
    ...(audioTracks.length > 1 ? [{ id: "audio" as const, label: "Audio" }] : []),
    { id: "style", label: "Style" },
    { id: "timing", label: "Timing" },
  ];

  return (
    <dialog
      ref={panel}
      open
      aria-label="Audio and subtitles"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="dark absolute inset-y-3 start-auto end-3 z-20 m-0 flex h-auto w-[min(25rem,calc(100%-1.5rem))] max-w-none border-0 p-0 flex-col overflow-hidden rounded-[1.75rem] bg-[rgb(18_16_14/0.86)] text-foreground shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] ring-1 ring-white/10 backdrop-blur-3xl backdrop-saturate-150 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-6 motion-safe:duration-300"
    >
      <header className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div
          role="tablist"
          aria-label="Panel"
          className="flex flex-1 gap-0.5 rounded-full bg-white/7 p-0.5"
        >
          {tabs.map((each) => (
            <button
              key={each.id}
              type="button"
              role="tab"
              aria-selected={tab === each.id}
              data-autofocus={tab === each.id || undefined}
              onClick={() => onTabChange(each.id)}
              className={cn(
                "h-8 flex-1 rounded-full text-small font-[600] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                tab === each.id ? "bg-white text-black" : "text-white/65 hover:text-white",
              )}
            >
              {each.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid size-9 shrink-0 place-items-center rounded-full text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4.5"
        >
          <X />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tab === "subtitles" && (
          <SubtitlesTab
            subtitleTracks={subtitleTracks}
            addedIds={addedIds}
            subtitleId={subtitleId}
            onPickTrack={onPickTrack}
            addonSubtitles={addonSubtitles}
            addonLoading={addonLoading}
            addonKey={addonKey}
            loadingKey={loadingKey}
            onPickAddon={onPickAddon}
            preferredLanguage={preferredLanguage}
          />
        )}
        {tab === "audio" && (
          <AudioTab audioTracks={audioTracks} audioId={audioId} onPickAudio={onPickAudio} />
        )}
        {tab === "style" && <StyleTab style={style} onStyleChange={onStyleChange} />}
        {tab === "timing" && (
          <TimingTab
            delay={delay}
            onDelayChange={onDelayChange}
            position={position}
            subtitleText={subtitleText}
            hasSubtitles={subtitleId > 0}
          />
        )}
      </div>
    </dialog>
  );
}

// --- Subtitles ------------------------------------------------------------

function SubtitlesTab({
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
}: {
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
}) {
  const choices: Choice[] = subtitleTracks
    .filter((track) => !addedIds.has(track.id))
    .map((track) => ({
      kind: "track" as const,
      key: `track:${track.id}`,
      language: subtitleLanguage(track.lang ?? "").language,
      track,
    }));
  const numbers = new Map<string, number>();
  for (const subtitle of addonSubtitles) {
    const number = (numbers.get(subtitle.language) ?? 0) + 1;
    numbers.set(subtitle.language, number);
    choices.push({
      kind: "addon",
      key: subtitle.key,
      language: subtitle.language,
      subtitle,
      number,
    });
  }

  // Languages: the profile's first, then by name; each with its count.
  const want = subtitleLanguage(preferredLanguage).code;
  const languages = [...new Set(choices.map((choice) => choice.language))].toSorted(
    (a, b) =>
      rankLanguage(a, want) - rankLanguage(b, want) ||
      languageLabel(a).localeCompare(languageLabel(b)),
  );
  const [filter, setFilter] = useState<string>("all");
  const shownLanguages = filter === "all" ? languages : languages.filter((l) => l === filter);
  const selectedKey =
    subtitleId === 0
      ? "off"
      : (addonKey ?? (addedIds.has(subtitleId) ? undefined : `track:${subtitleId}`));

  return (
    <div className="flex flex-col pb-4">
      <div className="px-4">
        <ChoiceRow
          selected={selectedKey === "off"}
          onPick={() => onPickTrack(0)}
          title="Off"
          detail="No subtitles, except forced ones"
        />
      </div>
      {languages.length > 1 && (
        <fieldset className="no-scrollbar sticky top-0 z-10 flex min-w-0 gap-1.5 overflow-x-auto border-0 bg-[rgb(18_16_14/0.92)] px-4 py-3 backdrop-blur-xl">
          <legend className="sr-only">Languages</legend>
          <LanguageChip active={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="tnum opacity-60">{choices.length}</span>
          </LanguageChip>
          {languages.map((language) => (
            <LanguageChip
              key={language}
              active={filter === language}
              onClick={() => setFilter(language)}
            >
              {languageLabel(language)}{" "}
              <span className="tnum opacity-60">
                {choices.filter((choice) => choice.language === language).length}
              </span>
            </LanguageChip>
          ))}
        </fieldset>
      )}
      {shownLanguages.map((language) => (
        <section key={language} aria-label={languageLabel(language)} className="px-4 pt-2">
          <h3 className="px-2 pt-2 pb-1.5 font-display text-[1.375rem] leading-none">
            {languageLabel(language)}
          </h3>
          <ul className="flex flex-col">
            {choices
              .filter((choice) => choice.language === language)
              .map((choice) => (
                <li key={choice.key}>
                  {choice.kind === "track" ? (
                    <TrackRow
                      track={choice.track}
                      selected={selectedKey === choice.key}
                      onPick={() => onPickTrack(choice.track.id)}
                    />
                  ) : (
                    <ChoiceRow
                      selected={selectedKey === choice.key}
                      loading={loadingKey === choice.key}
                      onPick={() => onPickAddon(choice.subtitle)}
                      title={choice.subtitle.name || `${languageLabel(language)} ${choice.number}`}
                      detail={choice.subtitle.addon}
                    />
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
      {addonLoading && (
        <p className="flex items-center gap-2 px-6 pt-4 text-small text-white/55">
          <Spinner className="size-3.5" />
          Asking your subtitle addons…
        </p>
      )}
      {choices.length === 0 && !addonLoading && (
        <p className="px-6 pt-4 text-small text-white/55">
          This file has no subtitles, and none of your addons has any for it.
        </p>
      )}
    </div>
  );
}

// The profile's language first.
const rankLanguage = (language: string, want: string) =>
  want && subtitleLanguage(language).code === want ? 0 : 1;

function TrackRow({
  track,
  selected,
  onPick,
}: {
  track: Track;
  selected: boolean;
  onPick: () => void;
}) {
  const { name, detail } = trackLabel(track);
  return (
    <ChoiceRow
      selected={selected}
      onPick={onPick}
      title={name}
      detail={
        <>
          <span className="rounded-[4px] bg-white/12 px-1.5 py-px text-[0.625rem] font-[700] tracking-[0.06em] text-white/75 uppercase">
            In file
          </span>
          {detail && <span className="truncate">{detail}</span>}
        </>
      }
    />
  );
}

function ChoiceRow({
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
        "group/choice flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-white/9" : "hover:bg-white/5",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full transition-colors",
          selected ? "bg-sun text-sun-foreground" : "ring-1.5 ring-white/25 ring-inset",
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3.5} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[0.875rem] font-[580]">{title}</span>
        {detail && (
          <span className="flex min-w-0 items-center gap-1.5 text-tiny text-white/50">
            {detail}
          </span>
        )}
      </span>
      {loading && <Spinner className="size-4 shrink-0 text-white/60" />}
    </button>
  );
}

function LanguageChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7.5 shrink-0 rounded-full px-3 text-small font-[560] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-white text-black"
          : "bg-white/8 text-white/75 hover:bg-white/14 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

// --- Audio ----------------------------------------------------------------

function AudioTab({
  audioTracks,
  audioId,
  onPickAudio,
}: {
  audioTracks: Track[];
  audioId: number;
  onPickAudio: (id: number) => void;
}) {
  return (
    <ul className="flex flex-col px-4 pb-4">
      {audioTracks.map((track) => {
        const { name, detail } = trackLabel(track);
        return (
          <li key={track.id}>
            <ChoiceRow
              selected={track.id === audioId}
              onPick={() => onPickAudio(track.id)}
              title={name}
              detail={detail}
            />
          </li>
        );
      })}
    </ul>
  );
}

// --- Style ----------------------------------------------------------------

const fontFamilies: { sans: string; serif: string; mono: string } & Record<string, string> = {
  sans: '"Helvetica Neue", "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: "Menlo, Consolas, ui-monospace, monospace",
};

const colors = [
  { value: "#FFFFFF", name: "White" },
  { value: "#F4EFE7", name: "Cream" },
  { value: "#FFE14D", name: "Yellow" },
  { value: "#FFC46B", name: "Amber" },
  { value: "#7FE3FF", name: "Cyan" },
  { value: "#9BF0A7", name: "Green" },
];

const edges = [
  { value: "none", name: "None" },
  { value: "outline", name: "Outline" },
  { value: "shadow", name: "Shadow" },
  { value: "box", name: "Box" },
];

// The sample line, drawn as the player will draw it, near enough.
export function subtitlePreviewStyle(style: SubtitleStyle, base = 17): CSSProperties {
  const edge: CSSProperties =
    style.edge === "outline"
      ? {
          textShadow: [
            "-1.5px -1.5px 0 #000",
            "1.5px -1.5px 0 #000",
            "-1.5px 1.5px 0 #000",
            "1.5px 1.5px 0 #000",
            "0 0 2px #000",
          ].join(", "),
        }
      : style.edge === "shadow"
        ? { textShadow: "0 0 1px rgb(0 0 0 / 0.6), 2px 2px 3px rgb(0 0 0 / 0.75)" }
        : style.edge === "box"
          ? {
              backgroundColor: `rgb(0 0 0 / ${style.backdrop / 100})`,
              padding: "0.1em 0.4em",
              boxDecorationBreak: "clone",
              WebkitBoxDecorationBreak: "clone",
            }
          : {};
  return {
    fontFamily: fontFamilies[style.font],
    fontSize: `${(base * style.size) / 100}px`,
    fontWeight: style.bold ? 700 : 500,
    color: style.color,
    lineHeight: 1.3,
    ...edge,
  };
}

// The style editor, for Settings too: the preview and every control.
export function SubtitleStyleEditor(props: {
  style: SubtitleStyle;
  onStyleChange: (style: SubtitleStyle) => void;
}) {
  return <StyleTab {...props} />;
}

function StyleTab({
  style,
  onStyleChange,
}: {
  style: SubtitleStyle;
  onStyleChange: (style: SubtitleStyle) => void;
}) {
  const set = (patch: Partial<SubtitleStyle>) => onStyleChange({ ...style, ...patch });
  const isDefault = JSON.stringify(style) === JSON.stringify(defaultSubtitleStyle);
  return (
    <div className="flex flex-col gap-6 px-5 pb-6">
      {/* The preview: a dusky frame with the line where the player puts it. */}
      <div
        aria-hidden
        className="relative aspect-video overflow-hidden rounded-2xl ring-1 ring-white/10"
        style={{
          backgroundImage: [
            "radial-gradient(70% 60% at 70% 30%, oklch(0.72 0.12 60), transparent 70%)",
            "radial-gradient(60% 70% at 20% 80%, oklch(0.4 0.08 250), transparent 70%)",
            "linear-gradient(170deg, oklch(0.55 0.08 40), oklch(0.18 0.03 260))",
          ].join(", "),
        }}
      >
        <p
          className="absolute inset-x-4 text-center text-balance"
          style={{ bottom: `${6 + style.lift * 0.9}%` }}
        >
          <span style={subtitlePreviewStyle(style)}>
            The light finds a way in,
            <br />
            even through the smallest crack.
          </span>
        </p>
      </div>

      <Field label="Font">
        <Segmented
          label="Font"
          value={style.font}
          onChange={(font) => set({ font })}
          options={[
            { value: "sans", name: "Sans", family: fontFamilies.sans },
            { value: "serif", name: "Serif", family: fontFamilies.serif },
            { value: "mono", name: "Mono", family: fontFamilies.mono },
          ]}
        />
      </Field>

      <Field label="Size" value={`${style.size}%`}>
        <Stepper
          label="Size"
          value={style.size}
          min={50}
          max={200}
          step={5}
          onChange={(size) => set({ size })}
        />
      </Field>

      <Field label="Colour">
        <div className="flex gap-2.5">
          {colors.map((color) => (
            <button
              key={color.value}
              type="button"
              aria-pressed={style.color === color.value}
              aria-label={color.name}
              title={color.name}
              onClick={() => set({ color: color.value })}
              className={cn(
                "size-8 rounded-full outline-none transition-[box-shadow,scale] focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-90",
                style.color === color.value
                  ? "shadow-[0_0_0_2px_rgb(18_16_14),0_0_0_4px_white]"
                  : "shadow-[inset_0_0_0_1px_rgb(0_0_0/0.25)]",
              )}
              style={{ backgroundColor: color.value }}
            />
          ))}
        </div>
      </Field>

      <Field label="Edge">
        <Segmented
          label="Edge"
          value={style.edge}
          onChange={(edge) => set({ edge })}
          options={edges}
        />
      </Field>

      {style.edge === "box" && (
        <Field label="Box opacity" value={`${style.backdrop}%`}>
          <PanelSlider
            label="Box opacity"
            value={style.backdrop}
            min={0}
            max={100}
            step={5}
            onChange={(backdrop) => set({ backdrop })}
          />
        </Field>
      )}

      <Field label="Position" value={style.lift === 0 ? "Bottom" : `Raised ${style.lift}%`}>
        <PanelSlider
          label="Raise subtitles"
          value={style.lift}
          min={0}
          max={30}
          step={1}
          onChange={(lift) => set({ lift })}
        />
      </Field>

      <div className="flex flex-col divide-y divide-white/8 rounded-2xl bg-white/5">
        <Toggle label="Bold" checked={style.bold} onChange={(bold) => set({ bold })} />
        <Toggle
          label="Restyle styled subtitles"
          hint="Anime and some films bring their own fonts and colours. On, they take yours."
          checked={style.override}
          onChange={(override) => set({ override })}
        />
      </div>

      <button
        type="button"
        disabled={isDefault}
        onClick={() => onStyleChange(defaultSubtitleStyle)}
        className="flex items-center justify-center gap-2 self-center rounded-full px-4 py-2 text-small font-[590] text-white/70 outline-none hover:bg-white/8 hover:text-white focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 [&_svg]:size-3.5"
      >
        <RotateCcw />
        Back to the default look
      </button>
    </div>
  );
}

function Field({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
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

function Segmented({
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

function PanelSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  center = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
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
      className="w-full"
    >
      <Slider.Control className="relative flex h-6 cursor-pointer touch-none items-center select-none">
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

function Stepper({
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

function RoundStep({
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

function Toggle({
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

// --- Timing ---------------------------------------------------------------

// The ruler's reach either way; the steps and the keys go further.
const rulerReach = 5;

// A delay Go takes: within its reach, to the hundredth.
const clamp = (to: number) =>
  Math.max(-maxSubtitleDelay, Math.min(maxSubtitleDelay, Math.round(to * 100) / 100));

// "0.4", "1.0", "0.05": a delay's size, to the hundredth, one decimal at least.
const amount = (delay: number) => Math.abs(delay).toFixed(2).replace(/0$/, "");

// "+0.4 s", "−1.25 s", "0.0 s".
function signedSeconds(delay: number): string {
  if (Math.abs(delay) < 0.005) return "0.0 s";
  return `${delay > 0 ? "+" : "−"}${amount(delay)} s`;
}

function TimingTab({
  delay,
  onDelayChange,
  position,
  subtitleText,
  hasSubtitles,
}: {
  delay: number;
  onDelayChange: (delay: number) => void;
  position: number;
  subtitleText: string;
  hasSubtitles: boolean;
}) {
  const nudge = (by: number) => onDelayChange(clamp(delay + by));
  // Sync by ear: when the line was heard, by the player's clock.
  const [heard, setHeard] = useState<number>();
  const [lastFix, setLastFix] = useState<number>();
  const markHeard = () => {
    setHeard(position);
    setLastFix(undefined);
  };
  const markSeen = () => {
    if (heard === undefined) return;
    // The subtitle came `late` seconds after the speech: show it that much
    // earlier. (Negative: it came first, show it later.)
    const late = position - heard;
    const fix = clamp(delay - late);
    onDelayChange(fix);
    setLastFix(fix - delay);
    setHeard(undefined);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "h") {
        event.preventDefault();
        markHeard();
      } else if (key === "j") {
        event.preventDefault();
        markSeen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const inSync = Math.abs(delay) < 0.005;
  return (
    <div className="flex flex-col gap-6 px-5 pb-6">
      <div className="flex flex-col items-center gap-1 pt-2 text-center">
        <p
          aria-live="polite"
          className={cn(
            "font-display text-[3.75rem] leading-none tnum",
            inSync ? "text-white" : "text-[#ffc46b]",
          )}
        >
          {signedSeconds(delay)}
        </p>
        <p className="text-small text-white/60">
          {inSync
            ? "Subtitles show when the file says"
            : `Subtitles show ${amount(delay)} s ${delay > 0 ? "later" : "earlier"}`}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <PanelSlider
          label="Subtitle timing"
          value={Math.max(-rulerReach, Math.min(rulerReach, delay))}
          min={-rulerReach}
          max={rulerReach}
          step={0.05}
          center
          onChange={(to) => onDelayChange(clamp(to))}
        />
        <div aria-hidden className="flex justify-between text-tiny text-white/40 tnum">
          <span>Earlier · 5 s</span>
          <span>0</span>
          <span>5 s · Later</span>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1.5">
        <NudgeButton onClick={() => nudge(-1)}>−1</NudgeButton>
        <NudgeButton onClick={() => nudge(-0.1)} keyHint="Z">
          −0.1
        </NudgeButton>
        <NudgeButton onClick={() => onDelayChange(0)} disabled={inSync}>
          0
        </NudgeButton>
        <NudgeButton onClick={() => nudge(0.1)} keyHint="X">
          +0.1
        </NudgeButton>
        <NudgeButton onClick={() => nudge(1)}>+1</NudgeButton>
      </div>

      <section aria-label="Sync by ear" className="flex flex-col gap-4 rounded-2xl bg-white/5 p-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-display text-[1.375rem] leading-none">Sync by ear</h3>
          <p className="text-tiny leading-snug text-white/55">
            Press <b className="text-white/80">Heard</b> the moment someone starts a line, then{" "}
            <b className="text-white/80">Seen</b> when its subtitle appears. Sinag takes the gap
            off.
          </p>
        </div>
        <div
          aria-live="polite"
          className="flex min-h-14 items-center justify-center rounded-xl bg-black/40 px-3 py-2 text-center text-small text-balance text-white/85"
        >
          {hasSubtitles ? (
            subtitleText || <span className="text-white/35">Waiting for a line…</span>
          ) : (
            <span className="text-white/35">Pick subtitles first</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <EarButton
            icon={<Ear />}
            label="Heard"
            keyHint="H"
            active={heard !== undefined}
            onClick={markHeard}
            disabled={!hasSubtitles}
          />
          <EarButton
            icon={<Eye />}
            label="Seen"
            keyHint="J"
            onClick={markSeen}
            disabled={heard === undefined}
          />
        </div>
        {lastFix !== undefined && (
          <p className="text-center text-tiny text-white/60">
            Moved {amount(lastFix)} s {lastFix < 0 ? "earlier" : "later"}. Try another line to
            check.
          </p>
        )}
      </section>
    </div>
  );
}

function NudgeButton({
  onClick,
  disabled = false,
  keyHint,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  keyHint?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-keyshortcuts={keyHint}
      className="relative flex h-11 flex-col items-center justify-center rounded-xl bg-white/7 text-small font-[620] text-white tnum outline-none transition-[background-color,scale] hover:bg-white/13 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 motion-safe:active:scale-95"
    >
      {children}
      {keyHint && (
        <span aria-hidden className="text-[0.5625rem] font-[700] tracking-[0.08em] text-white/40">
          {keyHint}
        </span>
      )}
    </button>
  );
}

function EarButton({
  icon,
  label,
  keyHint,
  active = false,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  keyHint: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-keyshortcuts={keyHint}
      className={cn(
        "flex h-12 items-center justify-center gap-2 rounded-xl text-[0.875rem] font-[620] outline-none transition-[background-color,color,scale] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 motion-safe:active:scale-95 [&_svg]:size-4.5",
        active ? "bg-sun text-sun-foreground" : "bg-white text-black hover:bg-white/90",
      )}
    >
      {icon}
      {label}
      <span aria-hidden className="rounded-[4px] bg-black/12 px-1 text-[0.625rem] font-[750]">
        {keyHint}
      </span>
    </button>
  );
}
