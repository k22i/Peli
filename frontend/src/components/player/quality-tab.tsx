import { useState } from "react";

import {
  Field,
  PanelSlider,
  previewRow,
  SectionHead,
  Segmented,
  Toggle,
  type Preview,
} from "@/components/player/panel-controls";
import {
  debandLevels,
  deinterlaceModes,
  heavyWarning,
  maxTargetPeak,
  minTargetPeak,
  peakLabel,
  scalingHint,
  scalingPresets,
  toneMappings,
  upscalerHint,
  upscalers,
  type Quality,
} from "@/lib/quality";

export type QualityProps = {
  quality: Quality;
  // Whether the title has a quality of its own (Reset has something to do).
  own: boolean;
  // Whether this screen shows the video as HDR: tone mapping doesn't apply.
  hdrShown: boolean;
  onPreview: (quality: Quality) => void;
  onChange: (quality: Quality) => void;
  onReset: () => void;
  // Makes it this device's default.
  onUseForAll: () => void;
};

const options = (list: readonly { id: string; name: string }[]) =>
  list.map(({ id, name }) => ({ value: id, name }));

const hint = (text: string | undefined, hidden: string) =>
  text && <p className={`text-tiny leading-snug text-white/50 ${hidden}`}>{text}</p>;

export function QualityTab({
  quality,
  own,
  hdrShown,
  onPreview,
  onChange,
  onReset,
  preview,
}: QualityProps & { preview: Preview }) {
  const [draft, setDraft] = useState<Quality>();
  const shown = draft ?? quality;
  const hidden = previewRow(preview);
  const warning = heavyWarning(shown);

  // A slider: previews as it moves, keeps the value let go.
  const slider = (
    row: string,
    label: string,
    value: number,
    shownValue: string,
    bounds: { min: number; max: number; step: number },
    set: (value: number) => Quality,
  ) => (
    <div className={previewRow(preview, row)}>
      <Field label={label} value={shownValue}>
        <PanelSlider
          label={label}
          value={value}
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          onActive={(on) => {
            preview.setActive(on ? row : undefined);
            if (!on) setDraft(undefined);
          }}
          onChange={(next) => {
            const changed = set(next);
            setDraft(changed);
            onPreview(changed);
          }}
          onCommit={(next) => {
            setDraft(undefined);
            onChange(set(next));
          }}
        />
      </Field>
    </div>
  );

  return (
    <section aria-label="Quality" className="flex flex-col gap-5 px-4 pb-5">
      <SectionHead title="Quality" className={hidden} reset={own ? onReset : undefined} />

      <div className={`flex flex-col gap-2 ${hidden}`}>
        <Field label="Scaling">
          <Segmented
            label="Scaling"
            value={shown.scaling}
            onChange={(scaling) => onChange({ ...shown, scaling })}
            options={options(scalingPresets)}
          />
        </Field>
        {hint(scalingHint[shown.scaling], "")}
      </div>

      <div className={`flex flex-col gap-2 ${hidden}`}>
        <Field label="Debanding">
          <Segmented
            label="Debanding"
            value={shown.deband}
            onChange={(deband) => onChange({ ...shown, deband })}
            options={options(debandLevels)}
          />
        </Field>
        {hint("Smooths the steps in skies and dark gradients. High can soften fine texture.", "")}
      </div>

      {slider(
        "sharpen",
        "Sharpening",
        shown.sharpen,
        shown.sharpen === 0 ? "Off" : `${shown.sharpen * 10} %`,
        { min: 0, max: 10, step: 1 },
        (sharpen) => ({ ...shown, sharpen }),
      )}

      <div className={`flex flex-col gap-2 ${hidden}`}>
        <Field label="Upscaling">
          <Segmented
            label="Upscaling"
            value={shown.upscaler}
            onChange={(upscaler) => onChange({ ...shown, upscaler })}
            options={options(upscalers)}
          />
        </Field>
        {hint(upscalerHint[shown.upscaler], "")}
      </div>

      <div className={`-mx-4 ${hidden}`}>
        <Toggle
          label="Motion smoothing"
          hint="Shows frames in step with the screen and blends between them: smoother pans, but films can look like TV (the soap-opera look). Uses more power."
          checked={shown.motionSmoothing}
          onChange={(motionSmoothing) => onChange({ ...shown, motionSmoothing })}
        />
      </div>
      {hint(warning, hidden)}

      <div className={`flex flex-col gap-2 ${hidden}`}>
        <Field label="Deinterlacing">
          <Segmented
            label="Deinterlacing"
            value={shown.deinterlace}
            onChange={(deinterlace) => onChange({ ...shown, deinterlace })}
            options={options(deinterlaceModes)}
          />
        </Field>
        {hint("For TV recordings and DVDs. Auto only deinterlaces video marked as interlaced.", "")}
      </div>

      <div className={`flex flex-col gap-2 ${hidden}`}>
        <Field label="HDR on this screen">
          <Segmented
            label="Tone mapping"
            value={shown.toneMapping}
            onChange={(toneMapping) => onChange({ ...shown, toneMapping })}
            options={options(toneMappings)}
          />
        </Field>
        {hint(
          hdrShown
            ? "This screen shows this video as HDR, so these don't apply to it."
            : "How HDR video is brought into what a screen without HDR shows.",
          "",
        )}
      </div>
      {slider(
        "peak",
        "Screen brightness",
        shown.targetPeak === 0 ? minTargetPeak - 20 : shown.targetPeak,
        peakLabel(shown.targetPeak),
        { min: minTargetPeak - 20, max: maxTargetPeak, step: 20 },
        // The left end is mpv's own guess.
        (value) => ({ ...shown, targetPeak: value < minTargetPeak ? 0 : value }),
      )}
    </section>
  );
}
