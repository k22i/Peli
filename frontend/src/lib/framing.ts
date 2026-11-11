import type { Crop, Framing, ProfileSettings, TitleAdjustments } from "@bindings/store";

export type { Crop, Framing };

// How the picture fills the window (internal/player/framing.go): the fit,
// the aspect ratio, zoom and pan, a crop (by hand or found), rotation and
// flips. A title keeps all of it; a profile sets the fit and auto-crop.

export const fitModes = [
  { id: "fit", name: "Fit" },
  { id: "fill", name: "Fill" },
  { id: "stretch", name: "Stretch" },
  { id: "original", name: "Original" },
] as const;

export const aspectRatios = [
  { id: "auto", name: "Auto" },
  { id: "16:9", name: "16:9" },
  { id: "4:3", name: "4:3" },
  { id: "1.85:1", name: "1.85" },
  { id: "2.35:1", name: "2.35" },
  { id: "2.39:1", name: "2.39" },
  { id: "21:9", name: "21:9" },
] as const;

export const rotations = [0, 90, 180, 270] as const;

// The store's bounds.
export const maxCrop = 40;
export const minZoom = -2;
export const maxZoom = 2;

export const noCrop: Crop = { top: 0, right: 0, bottom: 0, left: 0 };

export const defaultFraming: Framing = {
  fit: "fit",
  aspect: "auto",
  zoom: 0,
  panX: 0,
  panY: 0,
  crop: noCrop,
  autoCrop: false,
  rotate: 0,
  flipH: false,
  flipV: false,
};

// What a title plays with, as Go's framingFor reads it: the title's own,
// else the profile's fit and auto-crop on the defaults.
export function framingOf(
  settings: ProfileSettings | undefined,
  adjustments: TitleAdjustments | null | undefined,
): Framing {
  if (adjustments?.framing) return adjustments.framing;
  const profile = settings?.framing;
  return profile
    ? { ...defaultFraming, fit: profile.fit, autoCrop: profile.autoCrop }
    : defaultFraming;
}

// A "W:H" Go takes: two numbers above 0, up to two digits before the point.
export function validAspect(aspect: string): boolean {
  const match = /^(\d{1,2}(?:\.\d{1,3})?):(\d{1,2}(?:\.\d{1,3})?)$/.exec(aspect.trim());
  return match !== null && Number(match[1]) > 0 && Number(match[2]) > 0;
}

// The next of a list after current, round again at the end: Shift+F and
// Shift+A cycle the fit and aspect.
export function cycle<T>(list: readonly T[], current: T): T {
  const at = list.indexOf(current);
  return list[(at + 1) % list.length] ?? list[0]!;
}

export const fitName = (fit: string) => fitModes.find((each) => each.id === fit)?.name ?? "Fit";

export function aspectName(aspect: string): string {
  return aspectRatios.find((each) => each.id === aspect)?.name ?? aspect;
}

// "1×", "1.41×": a log-2 zoom as the factor it scales by.
export function zoomLabel(zoom: number): string {
  const factor = 2 ** zoom;
  return `${Number(factor.toFixed(2))}×`;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

// Zoom by steps of a quarter of a doubling, as mpv's keys do (+/-), within
// the bounds; zooming back to 1× centres the picture again.
export function zoomBy(framing: Framing, steps: number): Framing {
  const zoom = clamp(Math.round((framing.zoom + steps * 0.25) * 100) / 100, minZoom, maxZoom);
  return zoom === 0 ? { ...framing, zoom, panX: 0, panY: 0 } : { ...framing, zoom };
}

// Pan by a share of the picture, within its reach.
const thousandth = (v: number) => Math.round(v * 1000) / 1000;

export function panBy(framing: Framing, dx: number, dy: number): Framing {
  return {
    ...framing,
    panX: thousandth(clamp(framing.panX + dx, -1, 1)),
    panY: thousandth(clamp(framing.panY + dy, -1, 1)),
  };
}

// Zoom and pan back to none, keeping the fit, aspect, crop and turns: the 0
// key.
export const unzoomed = (framing: Framing): Framing => ({
  ...framing,
  zoom: 0,
  panX: 0,
  panY: 0,
});

// "12.6 % top and bottom" and the like: what auto-crop cut, for the sheet.
const pct = (v: number) => `${Number(v.toFixed(1))} %`;

export function cropSummary(crop: Crop): string {
  const parts: string[] = [];
  if (crop.top || crop.bottom) {
    parts.push(
      crop.top === crop.bottom
        ? `${pct(crop.top)} top and bottom`
        : `${pct(crop.top)} top, ${pct(crop.bottom)} bottom`,
    );
  }
  if (crop.left || crop.right) {
    parts.push(
      crop.left === crop.right
        ? `${pct(crop.left)} each side`
        : `${pct(crop.left)} left, ${pct(crop.right)} right`,
    );
  }
  return parts.join(", ");
}
