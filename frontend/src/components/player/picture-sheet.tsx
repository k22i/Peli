import { RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Field, PanelSlider, Toggle } from "@/components/player/panel-controls";
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
  type PictureControl,
} from "@/lib/picture";
import { cn } from "@/lib/utils";

export type PictureSheetTab = "picture";

// The sheet's surface, the subtitle panel's: warm near-black glass on the
// right. While a slider is dragged it gives way to the picture
// (`previewing`): only that slider's row stays, on its own pill.
const surface =
  "bg-[rgb(18_16_14/0.86)] shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] ring-1 ring-white/10 backdrop-blur-3xl backdrop-saturate-150 reduced-transparency:bg-[rgb(18_16_14)] reduced-transparency:backdrop-blur-none";

// The player's Picture & sound sheet (P): how this title plays. A change
// sticks to the title (the player saves it as the title's adjustment); Reset
// gives it back the profile's default, Use for all titles makes it that
// default.
export function PictureSheet({
  open,
  onClose,
  title,
  picture,
  presets,
  ownPicture,
  saves,
  onPreview,
  onChange,
  onReset,
  onUseForAll,
  onSavePreset,
}: {
  open: boolean;
  onClose: () => void;
  // The title's name, for whom the changes are kept.
  title: string;
  // What plays now.
  picture: Picture;
  // The profile's own presets.
  presets: readonly NamedPicture[];
  // Whether the title has a picture of its own (Reset has something to do).
  ownPicture: boolean;
  // Whether a change is kept for the title: false for a file nothing names,
  // whose changes last until it ends.
  saves: boolean;
  // A slider moves: show it, keep nothing yet.
  onPreview: (picture: Picture) => void;
  // A value to keep.
  onChange: (picture: Picture) => void;
  onReset: () => void;
  onUseForAll: () => void;
  onSavePreset: (name: string) => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const [active, setActive] = useState<PictureControl>();
  // The values while dragging: Go shows them, the sheet follows them.
  const [draft, setDraft] = useState<Picture>();
  const shown = draft ?? picture;

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open) return null;

  const previewing = active !== undefined;
  const hidden = (key?: PictureControl) => previewing && active !== key && "invisible";

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
        previewing ? "bg-transparent shadow-none ring-0" : surface,
      )}
    >
      <header className={cn("flex items-center gap-2 px-4 pt-4 pb-3", hidden())}>
        <div
          role="tablist"
          aria-label="Picture and sound"
          className="flex flex-1 gap-0.5 rounded-full bg-white/7 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected
            data-autofocus
            className="h-8 flex-1 rounded-full bg-white text-small font-[600] text-black outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Picture
          </button>
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
        <section aria-label="Picture" className="flex flex-col gap-5 px-4 pb-5">
          <SectionHead
            title="Picture"
            className={cn(hidden())}
            reset={ownPicture ? onReset : undefined}
          />
          <div className={cn(hidden())}>
            <PresetChips picture={shown} presets={presets} onPick={onChange} />
          </div>
          {pictureControls.map(({ key, label }) => (
            <div
              key={key}
              className={cn(
                hidden(key),
                active === key && cn("-mx-2 rounded-2xl px-2 py-2", surface),
              )}
            >
              <Field label={label} value={signed(shown[key])}>
                <PanelSlider
                  label={label}
                  value={shown[key]}
                  min={-100}
                  max={100}
                  step={1}
                  center
                  onActive={(on) => {
                    setActive(on ? key : undefined);
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
          <div className={cn("-mx-4", hidden())}>
            <Toggle
              label="Shadow lift"
              hint="Opens up dark scenes, for watching in a bright room."
              checked={shown.shadowLift}
              onChange={(shadowLift) => onChange(withValue(shown, { shadowLift }, presets))}
            />
          </div>
        </section>
      </div>
      <Footer
        className={cn(hidden())}
        title={title}
        saves={saves}
        full={presets.length >= maxNamedPictures}
        onUseForAll={onUseForAll}
        onSavePreset={onSavePreset}
      />
    </dialog>
  );
}

function SectionHead({
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
    <fieldset aria-label="Preset" className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
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
    </fieldset>
  );
}

function Chip({
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

function Footer({
  title,
  saves,
  full,
  onUseForAll,
  onSavePreset,
  className,
}: {
  title: string;
  saves: boolean;
  full: boolean;
  onUseForAll: () => void;
  onSavePreset: (name: string) => void;
  className?: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const save = () => {
    if (!name.trim()) return;
    onSavePreset(name.trim());
    setNaming(false);
    setName("");
  };
  return (
    <footer className={cn("flex flex-col gap-3 border-t border-white/8 px-4 py-4", className)}>
      <p className="text-tiny leading-snug text-white/55">
        {saves ? `Changes here are kept for ${title}.` : "Changes here last until this video ends."}
      </p>
      {naming ? (
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
          <FooterButton onClick={onUseForAll}>Use for all titles</FooterButton>
          <FooterButton
            disabled={full}
            title={
              full ? `You have ${maxNamedPictures} presets: delete one in Settings` : undefined
            }
            onClick={() => setNaming(true)}
          >
            Save as preset…
          </FooterButton>
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
