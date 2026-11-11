import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { FramingTab, type FramingProps } from "@/components/player/framing-tab";
import { QualityTab, type QualityProps } from "@/components/player/quality-tab";
import {
  Chip,
  ChipGroup,
  Field,
  PanelSlider,
  previewRow,
  SectionHead,
  sheetSurface,
  Toggle,
  type Preview,
} from "@/components/player/panel-controls";
import {
  maxNamedPictures,
  maxPresetName,
  pictureControls,
  picturePresets,
  presetPicture,
  signed,
  userPreset,
  withValue,
  type NamedPicture,
  type Picture,
} from "@/lib/picture";
import { cn } from "@/lib/utils";

export type PictureSheetTab = "picture" | "framing" | "quality";

export type PictureProps = {
  // What plays now.
  picture: Picture;
  // The profile's own presets.
  presets: readonly NamedPicture[];
  // Whether the title has a picture of its own (Reset has something to do).
  own: boolean;
  // A slider moves: show it, keep nothing yet.
  onPreview: (picture: Picture) => void;
  // A value to keep.
  onChange: (picture: Picture) => void;
  onReset: () => void;
  onUseForAll: () => void;
  onSavePreset: (name: string) => void;
};

const tabs: { id: PictureSheetTab; label: string }[] = [
  { id: "picture", label: "Picture" },
  { id: "framing", label: "Framing" },
  { id: "quality", label: "Quality" },
];

// The player's Picture & sound sheet (P): how this title plays. A change
// sticks to the title (the player saves it as the title's adjustment); Reset
// gives a section back the profile's default, Use for all titles makes it
// that default.
export function PictureSheet({
  open,
  onClose,
  tab,
  onTabChange,
  title,
  saves,
  picture,
  framing,
  quality,
}: {
  open: boolean;
  onClose: () => void;
  tab: PictureSheetTab;
  onTabChange: (tab: PictureSheetTab) => void;
  // The title's name, for whom the changes are kept.
  title: string;
  // Whether a change is kept for the title: false for a file nothing names,
  // whose changes last until it ends.
  saves: boolean;
  picture: PictureProps;
  framing: FramingProps;
  quality: QualityProps;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const [active, setActive] = useState<string>();
  const preview: Preview = { active, setActive };

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open) return null;

  const hidden = previewRow(preview);

  return (
    <dialog
      ref={panel}
      open
      aria-label="Picture and sound"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "dark absolute inset-y-3 start-auto end-3 z-20 m-0 flex h-auto w-[min(25rem,calc(100%-1.5rem))] max-w-none flex-col overflow-hidden rounded-[1.75rem] border-0 p-0 text-foreground transition-[background-color,box-shadow,backdrop-filter] duration-200 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-6 motion-safe:duration-300",
        active !== undefined ? "bg-transparent shadow-none ring-0" : sheetSurface,
      )}
    >
      <header className={cn("flex items-center gap-2 px-4 pt-4 pb-3", hidden)}>
        <div
          role="tablist"
          aria-label="Picture and sound"
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
        {tab === "picture" && <PictureTab {...picture} preview={preview} />}
        {tab === "framing" && <FramingTab {...framing} preview={preview} />}
        {tab === "quality" && <QualityTab {...quality} preview={preview} />}
      </div>
      <Footer
        className={hidden}
        title={title}
        saves={saves}
        onUseForAll={
          tab === "picture"
            ? picture.onUseForAll
            : tab === "framing"
              ? framing.onUseForAll
              : quality.onUseForAll
        }
        useForAllLabel={tab === "quality" ? "Use on this device" : "Use for all titles"}
        preset={
          tab === "picture"
            ? {
                full: picture.presets.length >= maxNamedPictures,
                onSave: picture.onSavePreset,
              }
            : undefined
        }
      />
    </dialog>
  );
}

function PictureTab({
  picture,
  presets,
  own,
  onPreview,
  onChange,
  onReset,
  preview,
}: PictureProps & { preview: Preview }) {
  // The values while dragging: Go shows them, the sheet follows them.
  const [draft, setDraft] = useState<Picture>();
  const shown = draft ?? picture;
  const hidden = previewRow(preview);
  return (
    <section aria-label="Picture" className="flex flex-col gap-5 px-4 pb-5">
      <SectionHead title="Picture" className={hidden} reset={own ? onReset : undefined} />
      <div className={hidden}>
        <PresetChips picture={shown} presets={presets} onPick={onChange} />
      </div>
      {pictureControls.map(({ key, label }) => (
        <div key={key} className={previewRow(preview, key)}>
          <Field label={label} value={signed(shown[key])}>
            <PanelSlider
              label={label}
              value={shown[key]}
              min={-100}
              max={100}
              step={1}
              center
              onActive={(on) => {
                preview.setActive(on ? key : undefined);
                if (!on) setDraft(undefined);
              }}
              onChange={(value) => {
                const next = withValue(shown, { [key]: value }, presets);
                setDraft(next);
                onPreview(next);
              }}
              onCommit={(value) => {
                setDraft(undefined);
                onChange(withValue(shown, { [key]: value }, presets));
              }}
            />
          </Field>
        </div>
      ))}
      <div className={cn("-mx-4", hidden)}>
        <Toggle
          label="Shadow lift"
          hint="Opens up dark scenes, for watching in a bright room."
          checked={shown.shadowLift}
          onChange={(shadowLift) => onChange(withValue(shown, { shadowLift }, presets))}
        />
      </div>
    </section>
  );
}

// The presets as chips: the built-in ones, Custom while the values are set by
// hand, then the profile's own.
function PresetChips({
  picture,
  presets,
  onPick,
}: {
  picture: Picture;
  presets: readonly NamedPicture[];
  onPick: (picture: Picture) => void;
}) {
  const chips: { id: string; name: string }[] = [
    ...picturePresets.map(({ id, name }) => ({ id, name })),
    ...(picture.preset === "custom" ? [{ id: "custom", name: "Custom" }] : []),
    ...presets.map(({ name }) => ({ id: userPreset(name), name })),
  ];
  return (
    <ChipGroup label="Preset">
      {chips.map((chip) => (
        <Chip
          key={chip.id}
          pressed={picture.preset === chip.id}
          onClick={() => {
            const next = presetPicture(chip.id, presets);
            if (next) onPick(next);
          }}
        >
          {chip.name}
        </Chip>
      ))}
    </ChipGroup>
  );
}

function Footer({
  title,
  saves,
  onUseForAll,
  useForAllLabel,
  preset,
  className,
}: {
  title: string;
  saves: boolean;
  onUseForAll: () => void;
  useForAllLabel: string;
  // Saving the values as a preset: the Picture tab's only.
  preset: { full: boolean; onSave: (name: string) => void } | undefined;
  className?: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const save = () => {
    if (!name.trim() || !preset) return;
    preset.onSave(name.trim());
    setNaming(false);
    setName("");
  };
  return (
    <footer className={cn("flex flex-col gap-3 border-t border-white/8 px-4 py-4", className)}>
      <p className="text-tiny leading-snug text-white/55">
        {saves ? `Changes here are kept for ${title}.` : "Changes here last until this video ends."}
      </p>
      {naming && preset ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field the button opened
            autoFocus
            aria-label="Preset name"
            placeholder="Preset name"
            maxLength={maxPresetName}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setNaming(false);
              }
            }}
            className="h-9 min-w-0 flex-1 rounded-full bg-white/8 px-3.5 text-[0.875rem] text-white outline-none placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <FooterButton type="submit" disabled={!name.trim()}>
            Save
          </FooterButton>
        </form>
      ) : (
        <div className="flex gap-2">
          <FooterButton onClick={onUseForAll}>{useForAllLabel}</FooterButton>
          {preset && (
            <FooterButton
              disabled={preset.full}
              title={
                preset.full
                  ? `You have ${maxNamedPictures} presets: delete one in Settings`
                  : undefined
              }
              onClick={() => setNaming(true)}
            >
              Save as preset…
            </FooterButton>
          )}
        </div>
      )}
    </footer>
  );
}

function FooterButton({
  type = "button",
  disabled = false,
  title,
  onClick,
  children,
}: {
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string | undefined;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      // oxlint-disable-next-line react/button-has-type -- one of two, given
      type={type}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="h-9 flex-1 rounded-full bg-white/10 px-3 text-[0.875rem] font-[580] text-white outline-none transition-[background-color,scale] hover:bg-white/16 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 motion-safe:active:scale-[0.98]"
    >
      {children}
    </button>
  );
}
