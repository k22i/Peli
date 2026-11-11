import type { AudioDevice } from "@bindings/player";
import type {
  Audio,
  DeviceSettings,
  ProfileSettings,
  Sound,
  TitleAdjustments,
} from "@bindings/store";

export type { Audio, AudioDevice, Sound };

// How a title sounds (internal/player/sound.go): dialogue boost, night mode
// and an equalizer preset, kept per title like the picture; and this
// device's output, its own setting.

export const equalizerPresets = [
  { id: "flat", name: "Flat" },
  { id: "voice", name: "Voice" },
  { id: "bass", name: "Bass" },
  { id: "treble", name: "Treble" },
  { id: "loudness", name: "Loudness" },
] as const;

export const equalizerHint: Record<string, string> = {
  flat: "The track as it was mixed.",
  voice: "Speech forward: less rumble, more presence.",
  bass: "More low end, for small speakers.",
  treble: "More detail up top, for muffled mixes.",
  loudness: "Lows and highs up a little, for listening quietly.",
};

export const defaultSound: Sound = { dialogueBoost: false, nightMode: false, equalizer: "flat" };
export const defaultAudio: Audio = { device: "auto", stereoDownmix: false, volumeBoost: false };

// What a title plays with, as Go's soundFor reads it.
export function soundOf(
  settings: ProfileSettings | undefined,
  adjustments: TitleAdjustments | null | undefined,
): Sound {
  return adjustments?.sound ?? settings?.sound ?? defaultSound;
}

export const audioOf = (device: DeviceSettings | undefined): Audio => device?.audio ?? defaultAudio;

// The audio delay's step and reach, as Go's (MaxAudioDelay).
export const audioDelayStep = 0.05;
export const maxAudioDelay = 10;

// "+0.25 s" (the sound later), "−0.1 s", "0.0 s".
export function audioDelayText(delay: number): string {
  if (Math.abs(delay) < 0.005) return "0.0 s";
  const amount = Math.abs(delay).toFixed(2).replace(/0$/, "");
  return `${delay > 0 ? "+" : "−"}${amount} s`;
}

// A device's name for people: mpv's description, "System default" for auto.
export function deviceName(device: AudioDevice): string {
  if (device.name === "auto") return "System default";
  return device.description || device.name;
}

// "Volume 120 %": a volume within this device's reach.
export const clampVolume = (volume: number, max: number) =>
  Math.max(0, Math.min(max, Math.round(volume)));
