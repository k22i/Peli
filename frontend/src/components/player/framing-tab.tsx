import { useState } from "react";

import {
  Chip,
  ChipGroup,
  Field,
  PanelSlider,
  previewRow,
  SectionHead,
  Segmented,
  Toggle,
  type Preview,
} from "@/components/player/panel-controls";
import { feature } from "@/lib/features";
import { isIOS } from "@/lib/platform";
import {
  aspectRatios,
  cropSummary,
  fitModes,
  maxCrop,
  maxZoom,
  minZoom,
  rotations,
  validAspect,
  zoomLabel,
  type Crop,
  type Framing,
} from "@/lib/framing";

export type FramingProps = {
  // How the picture is framed now.
  framing: Framing;
  // Whether the title has framing of its own (Reset has something to do).
  own: boolean;
  // What auto-crop found, once it has.
  found: Crop | undefined;
  onPreview: (framing: Framing) => void;
  onChange: (framing: Framing) => void;
  onReset: () => void;
  // Makes the fit and auto-crop the profile's.
  onUseForAll: () => void;
};

const edges = [
  { key: "top", label: "Top" },
  { key: "bottom", label: "Bottom" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
] as const;

const percent = (value: number) => `${Number(value.toFixed(1))} %`;

export function FramingTab({
  framing,
  own,
  found,
  onPreview,
  onChange,
  onReset,
  preview,
}: FramingProps & { preview: Preview }) {
  const [draft, setDraft] = useState<Framing>();
  const shown = draft ?? framing;
  const hidden = previewRow(preview);
  const custom = !aspectRatios.some((each) => each.id === shown.aspect);
  // The phone can't flip frames, and its pinch already fills the screen:
  // those rows are left out there.
  const flips = feature("framingFlips");
  const cropping = shown.autoCrop;
  // What the toggle says it does, or what it found: a phone takes no frame
  // bigger than 1080p while it looks for bars (the engine's cap), so its
  // hint says so.
  const cropHint = shown.autoCrop
    ? found && cropSummary(found)
      ? `Cutting ${cropSummary(found)}.`
      : "Looking for bars as it plays…"
    : "Finds the bars around a film and crops them, so a wide film fills a wide screen.";
  const cropNote = isIOS() ? " On iPhone, for videos up to 1080p." : "";
  const fits = fitModes.filter((each) => each.id !== "fill" || feature("fillFit"));
  const [naming, setNaming] = useState(custom);
  const [aspectText, setAspectText] = useState(custom ? shown.aspect : "");

  // A slider row: previews as it moves, keeps the value let go.
  const slider = (
    row: string,
    label: string,
    value: number,
    shownValue: string,
    bounds: { min: number; max: number; step: number; center?: boolean },
    set: (value: number) => Framing,
  ) => (
    <div key={row} className={previewRow(preview, row)}>
      <Field label={label} value={shownValue}>
        <PanelSlider
          label={label}
          value={value}
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          center={bounds.center ?? false}
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
    <section aria-label="Framing" className="flex flex-col gap-5 px-4 pb-5">
      <SectionHead title="Framing" className={hidden} reset={own ? onReset : undefined} />

      <div className={hidden}>
        <Field label="Fit">
          <Segmented
            label="Fit"
            value={shown.fit}
            onChange={(fit) => onChange({ ...shown, fit })}
            options={fits.map(({ id, name }) => ({ value: id, name }))}
          />
        </Field>
      </div>

      <div className={hidden}>
        <Field label="Aspect ratio">
          <ChipGroup label="Aspect ratio">
            {aspectRatios.map((each) => (
              <Chip
                key={each.id}
                pressed={shown.aspect === each.id}
                onClick={() => {
                  setNaming(false);
                  onChange({ ...shown, aspect: each.id });
                }}
              >
                {each.name}
              </Chip>
            ))}
            <Chip pressed={custom || naming} onClick={() => setNaming(true)}>
              {custom ? shown.aspect : "Custom…"}
            </Chip>
          </ChipGroup>
          {naming && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (validAspect(aspectText)) onChange({ ...shown, aspect: aspectText.trim() });
              }}
            >
              <input
                aria-label="Custom aspect ratio"
                placeholder="W:H, like 2.76:1"
                value={aspectText}
                onChange={(event) => setAspectText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setNaming(false);
                  }
                }}
                className="h-9 min-w-0 flex-1 rounded-full bg-white/8 px-3.5 text-[0.875rem] text-white tnum outline-none placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="submit"
                disabled={!validAspect(aspectText)}
                className="h-9 rounded-full bg-white/10 px-4 text-[0.875rem] font-[580] text-white outline-none hover:bg-white/16 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                Apply
              </button>
            </form>
          )}
        </Field>
      </div>

      {slider(
        "zoom",
        "Zoom",
        shown.zoom,
        zoomLabel(shown.zoom),
        { min: minZoom, max: maxZoom, step: 0.05, center: true },
        (zoom) => (zoom === 0 ? { ...shown, zoom, panX: 0, panY: 0 } : { ...shown, zoom }),
      )}
      {shown.zoom !== 0 && (
        <>
          {slider(
            "pan-x",
            "Move left or right",
            shown.panX,
            percent(shown.panX * 100),
            { min: -1, max: 1, step: 0.01, center: true },
            (panX) => ({ ...shown, panX }),
          )}
          {slider(
            "pan-y",
            "Move up or down",
            shown.panY,
            percent(shown.panY * 100),
            { min: -1, max: 1, step: 0.01, center: true },
            (panY) => ({ ...shown, panY }),
          )}
          <p className={`text-tiny leading-snug text-white/50 ${hidden}`}>
            Drag the picture to move it, or use Option and the arrow keys. = and − zoom, 0 puts it
            back.
          </p>
        </>
      )}

      <div className={`-mx-4 ${hidden}`}>
        <Toggle
          label="Remove black bars"
          hint={cropHint + cropNote}
          checked={shown.autoCrop}
          onChange={(autoCrop) => onChange({ ...shown, autoCrop })}
        />
      </div>
      {!cropping &&
        edges.map(({ key, label }) =>
          slider(
            `crop-${key}`,
            `Crop ${label.toLowerCase()}`,
            shown.crop[key],
            percent(shown.crop[key]),
            { min: 0, max: maxCrop, step: 0.5 },
            (value) => ({ ...shown, crop: { ...shown.crop, [key]: value } }),
          ),
        )}

      <div className={hidden}>
        <Field label="Rotate">
          <Segmented
            label="Rotate"
            value={String(shown.rotate)}
            onChange={(rotate) => onChange({ ...shown, rotate: Number(rotate) })}
            options={rotations.map((each) => ({ value: String(each), name: `${each}°` }))}
          />
        </Field>
      </div>

      {flips && (
        <div className={`-mx-4 flex flex-col ${hidden}`}>
          <Toggle
            label="Mirror"
            hint="Flipping copies each frame off the graphics card, which uses more power."
            checked={shown.flipH}
            onChange={(flipH) => onChange({ ...shown, flipH })}
          />
          <Toggle
            label="Upside down"
            checked={shown.flipV}
            onChange={(flipV) => onChange({ ...shown, flipV })}
          />
        </div>
      )}
    </section>
  );
}
