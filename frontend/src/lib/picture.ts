import type { NamedPicture, Picture, ProfileSettings, TitleAdjustments } from "@bindings/store";

export type { NamedPicture, Picture };

// The picture controls, as mpv's equalizer has them: -100 to 100, 0 is the
// file as it is. Go applies them in the renderer (internal/player/picture.go).
export const pictureControls = [
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "saturation", label: "Saturation" },
  { key: "gamma", label: "Gamma" },
  { key: "hue", label: "Hue" },
] as const;
export type PictureControl = (typeof pictureControls)[number]["key"];

type Values = Omit<Picture, "preset">;

const zero: Values = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  gamma: 0,
  hue: 0,
  shadowLift: false,
};

// The built-in presets (store.PicturePresets), tuned by eye on SDR test
// patterns and films: small steps, since the renderer's equalizer is linear
// and big ones clip.
export const picturePresets: { id: string; name: string; values: Values }[] = [
  { id: "standard", name: "Standard", values: zero },
  { id: "vivid", name: "Vivid", values: { ...zero, contrast: 8, saturation: 18, gamma: -2 } },
  // A dark room: a little dimmer and deeper, colour a touch calmer.
  {
    id: "cinema",
    name: "Cinema",
    values: { ...zero, brightness: -4, contrast: 6, saturation: -6, gamma: -4 },
  },
  // Flat cel colour and line art: fuller colour and crisper contrast.
  { id: "anime", name: "Anime", values: { ...zero, contrast: 6, saturation: 12, gamma: 2 } },
];

export const standardPicture: Picture = { preset: "standard", ...zero };

const userPrefix = "user:";
export const userPreset = (name: string) => `${userPrefix}${name}`;

// A preset's picture: a built-in one, or one of the profile's own (by
// "user:<name>"). An unknown one is undefined.
export function presetPicture(
  preset: string,
  named: readonly NamedPicture[] = [],
): Picture | undefined {
  if (preset.startsWith(userPrefix)) {
    const own = named.find((each) => userPreset(each.name) === preset);
    return own && { ...own.picture, preset };
  }
  const builtIn = picturePresets.find((each) => each.id === preset);
  return builtIn && { preset, ...builtIn.values };
}

// What a title plays with, as Go's pictureFor reads it: the title's own,
// else the profile's, else the file as it is.
export function pictureOf(
  settings: ProfileSettings | undefined,
  adjustments: TitleAdjustments | null | undefined,
): Picture {
  return adjustments?.picture ?? settings?.picture ?? standardPicture;
}

// Values set by hand: the preset becomes Custom, unless they're still that
// preset's.
export function withValue(
  picture: Picture,
  changes: Partial<Values>,
  named: readonly NamedPicture[] = [],
): Picture {
  const next = { ...picture, ...changes };
  const preset = presetPicture(picture.preset, named);
  return preset && samePicture(preset, next) ? next : { ...next, preset: "custom" };
}

export function samePicture(a: Picture, b: Picture): boolean {
  return (
    a.brightness === b.brightness &&
    a.contrast === b.contrast &&
    a.saturation === b.saturation &&
    a.gamma === b.gamma &&
    a.hue === b.hue &&
    a.shadowLift === b.shadowLift
  );
}

// "Standard", "Vivid", "Custom", or a preset of the profile's own by name.
export function presetName(preset: string): string {
  if (preset.startsWith(userPrefix)) return preset.slice(userPrefix.length);
  if (preset === "custom") return "Custom";
  return picturePresets.find((each) => each.id === preset)?.name ?? "Standard";
}

// The most presets of its own a profile keeps, and a name's longest; the
// store's caps.
export const maxNamedPictures = 8;
export const maxPresetName = 40;

// The profile's presets with picture saved as name: replacing one of that
// name, or added at the end; undefined when the list is full or the name
// empty.
export function savePreset(
  named: readonly NamedPicture[],
  name: string,
  picture: Picture,
): NamedPicture[] | undefined {
  const trimmed = name.trim().slice(0, maxPresetName);
  if (!trimmed) return undefined;
  const entry = { name: trimmed, picture: { ...picture, preset: "custom" } };
  const at = named.findIndex((each) => each.name === trimmed);
  if (at >= 0) return named.map((each, i) => (i === at ? entry : each));
  if (named.length >= maxNamedPictures) return undefined;
  return [...named, entry];
}

// "+8", "−4", "0": a control's value as the sheet shows it.
export const signed = (value: number) =>
  value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0";
