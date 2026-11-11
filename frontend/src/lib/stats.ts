import type { Stats } from "@bindings/player";

// The stats overlay (Shift+I): Go's Player.Stats, asked once a second while
// it shows, as rows of label and value.

export type { Stats };

export type StatsRow = { label: string; value: string };

export function statsRows(stats: Stats): StatsRow[] {
  const rows: StatsRow[] = [
    {
      label: "Video",
      value: join([
        codecName(stats.videoCodec),
        stats.fps > 0 ? `${Number(stats.fps.toFixed(3))} fps` : "",
        stats.pixelFormat,
      ]),
    },
    { label: "Resolution", value: resolution(stats) },
    { label: "HDR", value: hdrText(stats) },
    { label: "Decoder", value: stats.hwdec ? `Hardware (${stats.hwdec})` : "Software" },
    {
      label: "Dropped frames",
      value: `${stats.droppedFrames} by the renderer · ${stats.decoderDrops} by the decoder`,
    },
    {
      label: "Audio",
      value: join([codecName(stats.audioCodec), channels(stats.audioChannels)]),
    },
    {
      label: "Bitrate",
      value: join([
        stats.videoBitrate > 0 ? `${bitrate(stats.videoBitrate)} video` : "",
        stats.audioBitrate > 0 ? `${bitrate(stats.audioBitrate)} audio` : "",
      ]),
    },
    {
      label: "Cache",
      value: join([
        `${Math.round(stats.cacheSeconds)} s`,
        stats.cacheBytes > 0 ? `${bytes(stats.cacheBytes)} ahead` : "",
        stats.cacheSpeed > 0 ? `${bytes(stats.cacheSpeed)}/s` : "",
      ]),
    },
    { label: "Renderer", value: renderer(stats) },
  ];
  for (const row of rows) row.value ||= "—";
  return rows;
}

// What HDR the video is, and how it's shown: "HDR10 (PQ), shown as HDR",
// "Dolby Vision, tone-mapped to SDR", "SDR".
export function hdrText(stats: Pick<Stats, "gamma" | "colorMatrix" | "hdrShown">): string {
  const format =
    stats.colorMatrix === "dolbyvision"
      ? "Dolby Vision"
      : stats.gamma === "pq"
        ? "HDR10 (PQ)"
        : stats.gamma === "hlg"
          ? "HLG"
          : "";
  if (!format) return "SDR";
  return `${format}, ${stats.hdrShown ? "shown as HDR" : "tone-mapped to SDR"}`;
}

// "1.5 Mb/s", "640 kb/s".
export function bitrate(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(1)} Mb/s`;
  return `${Math.round(bitsPerSecond / 1e3)} kb/s`;
}

// "120 MB", "1.2 GB", "640 KB".
export function bytes(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)} GB`;
  if (count >= 1e6) return `${Math.round(count / 1e6)} MB`;
  return `${Math.round(count / 1e3)} KB`;
}

function resolution(stats: Stats): string {
  if (!stats.width || !stats.height) return "";
  const source = `${stats.width}×${stats.height}`;
  const shown = stats.outputWidth && stats.outputHeight;
  if (!shown || (stats.outputWidth === stats.width && stats.outputHeight === stats.height)) {
    return source;
  }
  return `${source}, shown at ${stats.outputWidth}×${stats.outputHeight}`;
}

function renderer(stats: Stats): string {
  // macOS draws through the render API's OpenGL renderer (ADR-0002).
  const name = stats.renderer === "libmpv" ? "OpenGL (render API)" : stats.renderer;
  return join([
    name,
    stats.gpuContext,
    stats.displayFps > 0 ? `${Math.round(stats.displayFps)} Hz` : "",
  ]);
}

const codecNames: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  mpeg2video: "MPEG-2",
  aac: "AAC",
  ac3: "AC-3",
  eac3: "E-AC-3",
  truehd: "TrueHD",
  dts: "DTS",
  opus: "Opus",
  flac: "FLAC",
  mp3: "MP3",
};

function codecName(codec: string): string {
  return codecNames[codec] ?? codec.toUpperCase();
}

function channels(count: number): string {
  const layouts: Record<number, string> = { 1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1" };
  return layouts[count] ?? (count > 0 ? `${count} channels` : "");
}

const join = (parts: string[]) => parts.filter(Boolean).join(" · ");
