import { describe, expect, it } from "vite-plus/test";

import { bitrate, bytes, hdrText, statsRows, type Stats } from "@/lib/stats";

const stats: Stats = {
  videoCodec: "hevc",
  width: 3840,
  height: 2160,
  fps: 23.976023,
  pixelFormat: "p010",
  gamma: "pq",
  primaries: "bt.2020",
  colorMatrix: "bt.2020-ncl",
  hdrShown: false,
  outputWidth: 1920,
  outputHeight: 1080,
  hwdec: "videotoolbox",
  droppedFrames: 2,
  decoderDrops: 0,
  audioCodec: "eac3",
  audioChannels: 6,
  videoBitrate: 18_400_000,
  audioBitrate: 640_000,
  cacheSeconds: 41.6,
  cacheBytes: 120_000_000,
  cacheSpeed: 3_200_000,
  renderer: "libmpv",
  gpuContext: "",
  displayFps: 60,
};

describe("statsRows", () => {
  it("says what plays and how", () => {
    expect(Object.fromEntries(statsRows(stats).map(({ label, value }) => [label, value]))).toEqual({
      Video: "HEVC · 23.976 fps · p010",
      Resolution: "3840×2160, shown at 1920×1080",
      HDR: "HDR10 (PQ), tone-mapped to SDR",
      Decoder: "Hardware (videotoolbox)",
      "Dropped frames": "2 by the renderer · 0 by the decoder",
      Audio: "E-AC-3 · 5.1",
      Bitrate: "18.4 Mb/s video · 640 kb/s audio",
      Cache: "42 s · 120 MB ahead · 3 MB/s",
      Renderer: "OpenGL (render API) · 60 Hz",
    });
  });

  it("shows a dash for what isn't known yet", () => {
    const rows = statsRows({
      ...stats,
      videoCodec: "",
      fps: 0,
      pixelFormat: "",
      width: 0,
      height: 0,
      videoBitrate: 0,
      audioBitrate: 0,
    });
    expect(rows.find((row) => row.label === "Resolution")?.value).toBe("—");
    expect(rows.find((row) => row.label === "Bitrate")?.value).toBe("—");
  });

  it("names Windows' renderer and its context", () => {
    const rows = statsRows({ ...stats, renderer: "gpu-next", gpuContext: "d3d11" });
    expect(rows.find((row) => row.label === "Renderer")?.value).toBe("gpu-next · d3d11 · 60 Hz");
  });
});

describe("hdrText", () => {
  it("names the format and whether it's shown as HDR", () => {
    expect(hdrText({ gamma: "bt.1886", colorMatrix: "bt.709", hdrShown: false })).toBe("SDR");
    expect(hdrText({ gamma: "pq", colorMatrix: "dolbyvision", hdrShown: true })).toBe(
      "Dolby Vision, shown as HDR",
    );
    expect(hdrText({ gamma: "hlg", colorMatrix: "bt.2020-ncl", hdrShown: false })).toBe(
      "HLG, tone-mapped to SDR",
    );
  });
});

describe("bitrate and bytes", () => {
  it("round to what reads at a glance", () => {
    expect(bitrate(1_500_000)).toBe("1.5 Mb/s");
    expect(bitrate(96_000)).toBe("96 kb/s");
    expect(bytes(1_200_000_000)).toBe("1.2 GB");
    expect(bytes(640_000)).toBe("640 KB");
  });
});
