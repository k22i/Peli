import type { DeviceSettings, Quality, TitleAdjustments } from "@bindings/store";

export type { Quality };

// How hard the renderer works on the picture (internal/player/quality.go).
// The default is this device's, since it depends on the GPU; a title may
// have its own. Costs are per frame, 1080p to a 4K window on an M1 Pro
// (build/libmpv/smoke/bench_darwin.c).

export const scalingPresets = [
  { id: "fast", name: "Fast" },
  { id: "balanced", name: "Balanced" },
  { id: "high", name: "High" },
] as const;

export const debandLevels = [
  { id: "off", name: "Off" },
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
] as const;

export const upscalers = [
  { id: "off", name: "Off" },
  { id: "fsr", name: "FSR" },
  { id: "anime4k", name: "Anime4K" },
] as const;

export const deinterlaceModes = [
  { id: "auto", name: "Auto" },
  { id: "on", name: "On" },
  { id: "off", name: "Off" },
] as const;

export const toneMappings = [
  { id: "auto", name: "Auto" },
  { id: "bt.2390", name: "Natural" },
  { id: "spline", name: "Bright" },
  { id: "hable", name: "Filmic" },
  { id: "mobius", name: "Soft" },
  { id: "clip", name: "Clip" },
] as const;

// The store's bounds; 0 is mpv's own guess.
export const minTargetPeak = 80;
export const maxTargetPeak = 1000;

export const defaultQuality: Quality = {
  scaling: "balanced",
  deband: "off",
  sharpen: 0,
  upscaler: "off",
  motionSmoothing: false,
  deinterlace: "auto",
  toneMapping: "auto",
  targetPeak: 0,
};

// What a title plays with, as Go's qualityFor reads it: the title's own,
// else this device's.
export function qualityOf(
  device: DeviceSettings | undefined,
  adjustments: TitleAdjustments | null | undefined,
): Quality {
  return adjustments?.quality ?? device?.quality ?? defaultQuality;
}

export const scalingHint: Record<string, string> = {
  fast: "Simple scaling: the least power, a little softer.",
  balanced: "mpv's own scaling, sharp and light.",
  high: "The sharpest scaling. About 2½ times the GPU work of Balanced: fine on its own, too much with motion smoothing on a 120 Hz screen.",
};

export const upscalerHint: Record<string, string> = {
  off: "Video smaller than the window is scaled as above.",
  fsr: "AMD's FSR: crisper edges for video smaller than the window. About twice the GPU work of plain scaling.",
  anime4k:
    "For animation smaller than the window: cleans up line art as it upscales. The heaviest option; meant for 1080p and below.",
};

// A warning when the choices are more than a 120 Hz screen can draw in
// time: motion smoothing renders every refresh (8 ms at 120 Hz), and High
// scaling or Anime4K take longer than that at 4K.
export function heavyWarning(quality: Quality): string | undefined {
  if (!quality.motionSmoothing) return undefined;
  if (quality.upscaler === "anime4k" || quality.scaling === "high") {
    return "With motion smoothing, this may drop frames on a 120 Hz screen. Try Balanced scaling.";
  }
  return undefined;
}

// "Auto" or "400 nits".
export const peakLabel = (peak: number) => (peak === 0 ? "Auto" : `${peak} nits`);
