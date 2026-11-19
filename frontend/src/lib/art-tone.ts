import { useEffect, useState } from "react";

import { viaProxy } from "@/lib/artwork-url";

// How bright art is, read from the image itself, so the hero can shade
// bright backdrops harder and show a dark logo as a white silhouette.
//
// The image is drawn small onto a canvas and its pixels read back. That only
// works when the image host allows cross-origin reads; as checked on
// 2026-11-19, image.tmdb.org, images/live.metahub.space, artworks.thetvdb.com
// and assets.fanart.tv answer `Access-Control-Allow-Origin: *`; media.kitsu.app
// sends nothing and s4.anilist.co echoes only http(s) origins (not wails://),
// so their art reads as unknown (null) and callers take the safe side. The
// sample asks for a small size where the host has one, so it costs a few kB.

export type ArtUse = "backdrop" | "logo";

// Relative luminance (0–1, linear light) and alpha (0–1) per cell, row by
// row, at the image's own aspect ratio.
export type ToneGrid = {
  width: number;
  height: number;
  lum: Float32Array;
  alpha: Float32Array;
};

// A region of the shown art, in fractions of the box it fills
// (`object-cover`), plus that box's width / height.
export type Region = { aspect: number; x0: number; x1: number; y0: number; y1: number };

// Art reads as bright behind the text when its average or its brighter
// patches pass these (linear luminance; mid-grey #808080 is 0.216).
export const brightMean = 0.25;
export const brightP90 = 0.6;
// A logo reads as dark when most of its opaque pixels are darker than this
// (#383838, under 2:1 against black): it would vanish on the shade.
export const darkLogoLum = 0.04;
export const darkLogoShare = 0.5;

const sampleWidth = 48;

const tmdb = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(w\d+|original)\//;
const metahubBackground =
  /^(https:\/\/(?:images|live)\.metahub\.space\/background\/)(medium|large)\//;

// The smallest size worth reading: TMDB w300 backdrops and w185 logos,
// Metahub's `small` background (480×270). Other URLs pass through.
export function sampleUrl(url: string, use: ArtUse): string {
  if (tmdb.test(url)) return url.replace(tmdb, `$1${use === "logo" ? "w185" : "w300"}/`);
  if (use === "backdrop" && metahubBackground.test(url)) {
    return url.replace(metahubBackground, "$1small/");
  }
  return url;
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// RGBA bytes (as ImageData holds them) to a grid.
export function toneGrid(data: ArrayLike<number>, width: number, height: number): ToneGrid {
  const lum = new Float32Array(width * height);
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    lum[i] =
      0.2126 * linear(data[o]!) + 0.7152 * linear(data[o + 1]!) + 0.0722 * linear(data[o + 2]!);
    alpha[i] = data[o + 3]! / 255;
  }
  return { width, height, lum, alpha };
}

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

// The mean and 90th percentile of the luminance in a region of the art as
// `object-cover` shows it in a box of `region.aspect`.
export function regionTone(grid: ToneGrid, region: Region): { mean: number; p90: number } {
  const image = grid.width / grid.height;
  // The part of the image the box shows, centred, in image fractions.
  const shownW = region.aspect > image ? 1 : region.aspect / image;
  const shownH = region.aspect > image ? image / region.aspect : 1;
  const left = (1 - shownW) / 2;
  const top = (1 - shownH) / 2;
  const cx0 = Math.floor(clamp(left + region.x0 * shownW) * grid.width);
  const cx1 = Math.ceil(clamp(left + region.x1 * shownW) * grid.width);
  const cy0 = Math.floor(clamp(top + region.y0 * shownH) * grid.height);
  const cy1 = Math.ceil(clamp(top + region.y1 * shownH) * grid.height);
  const values: number[] = [];
  for (let y = cy0; y < Math.max(cy1, cy0 + 1) && y < grid.height; y += 1) {
    for (let x = cx0; x < Math.max(cx1, cx0 + 1) && x < grid.width; x += 1) {
      values.push(grid.lum[y * grid.width + x]!);
    }
  }
  if (values.length === 0) return { mean: 0, p90: 0 };
  values.sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { mean, p90: values[Math.min(values.length - 1, Math.floor(values.length * 0.9))]! };
}

export function isBright(tone: { mean: number; p90: number }): boolean {
  return tone.mean > brightMean || tone.p90 > brightP90;
}

// Most of the logo's ink is near black.
export function isDarkLogo(grid: ToneGrid): boolean {
  let ink = 0;
  let dark = 0;
  for (let i = 0; i < grid.lum.length; i += 1) {
    if (grid.alpha[i]! < 0.5) continue;
    ink += 1;
    if (grid.lum[i]! < darkLogoLum) dark += 1;
  }
  return ink > 0 && dark / ink > darkLogoShare;
}

function sample(url: string): Promise<ToneGrid | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      resolve(null);
      return;
    }
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    const done = (grid: ToneGrid | null) => {
      image.removeAttribute("src");
      resolve(grid);
    };
    image.addEventListener("error", () => done(null), { once: true });
    image.addEventListener(
      "load",
      () => {
        try {
          const width = sampleWidth;
          const height = Math.max(
            1,
            Math.round((sampleWidth * image.naturalHeight) / Math.max(1, image.naturalWidth)),
          );
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) {
            done(null);
            return;
          }
          context.drawImage(image, 0, 0, width, height);
          // Throws on a tainted canvas: the host didn't allow the read.
          done(toneGrid(context.getImageData(0, 0, width, height).data, width, height));
        } catch {
          done(null);
        }
      },
      { once: true },
    );
    image.src = viaProxy(url);
  });
}

// One read per URL and use; the grids are a few kB, the oldest go first.
const cacheLimit = 200;
const pending = new Map<string, Promise<ToneGrid | null>>();
const known = new Map<string, ToneGrid | null>();

function remember(key: string, grid: ToneGrid | null) {
  known.delete(key);
  known.set(key, grid);
  if (known.size > cacheLimit) known.delete(known.keys().next().value!);
}

export function readTone(url: string, use: ArtUse): Promise<ToneGrid | null> {
  const key = `${use} ${url}`;
  if (known.has(key)) return Promise.resolve(known.get(key)!);
  let reading = pending.get(key);
  if (!reading) {
    reading = sample(sampleUrl(url, use)).then((grid) => {
      pending.delete(key);
      remember(key, grid);
      return grid;
    });
    pending.set(key, reading);
  }
  return reading;
}

// The art's grid: undefined while it's read (or with no URL), null when the
// host doesn't allow the read or the image fails.
export function useArtTone(url: string | undefined, use: ArtUse): ToneGrid | null | undefined {
  const key = url && `${use} ${url}`;
  const [read, setRead] = useState<{ key: string; grid: ToneGrid | null }>();
  useEffect(() => {
    if (!url || !key || known.has(key)) return undefined;
    let live = true;
    void readTone(url, use).then((grid) => {
      if (live) setRead({ key, grid });
    });
    return () => {
      live = false;
    };
  }, [url, use, key]);
  if (!key) return undefined;
  if (known.has(key)) return known.get(key);
  return read?.key === key ? read.grid : undefined;
}
