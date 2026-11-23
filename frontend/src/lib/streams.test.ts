import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { defaultQuality } from "@/lib/quality";
import { defaultAudio } from "@/lib/sound";
import type { Stream } from "@/lib/addon-protocol";

import type { DeviceSettings, ProfileSettings } from "@bindings/store";

import { profileSettings } from "@/test/fixtures";

import { StreamFeed, rankingPrefs, slices, type StreamSource } from "./streams";

vi.mock("@bindings/addons", () => ({ Service: { Fetch: vi.fn<() => void>() } }));
vi.mock("@bindings/store", () => ({ Service: {} }));
vi.mock("@bindings/plugins", () => ({ Service: {} }));
vi.mock("@bindings/secrets", () => ({ Service: {} }));

const streams = (count: number, from = 0): Stream[] =>
  Array.from({ length: count }, (_, i) => ({ name: `s${from + i}` }));

const source = (url: string, status: StreamSource["status"], answer?: Stream[]): StreamSource => ({
  key: url,
  name: url,
  kind: "addon",
  status,
  streams: answer,
  error: null,
  retry: () => {},
});

const shape = (out: { source: string; streams: readonly Stream[] }[]) =>
  out.map((slice) => `${slice.source}:${slice.streams.length}`);

describe("slices", () => {
  it("cuts an answer into slices of at most 150, in order", () => {
    const cut = slices(streams(320));
    expect(cut.map((slice) => slice.length)).toEqual([150, 150, 20]);
    expect(cut[1]![0]).toEqual({ name: "s150" });
    expect(slices([])).toEqual([]);
  });
});

describe("StreamFeed", () => {
  it("hands each answer on once, as addons answer", () => {
    const feed = new StreamFeed();
    expect(feed.take([source("a", "pending"), source("b", "pending")])).toEqual([]);

    const b = source("b", "success", streams(1400));
    expect(shape(feed.take([source("a", "pending"), b]))).toEqual([
      ...Array.from({ length: 9 }, () => "b:150"),
      "b:50",
    ]);
    // Re-rendered with the same answers: nothing new.
    expect(feed.take([source("a", "pending"), b])).toEqual([]);

    expect(shape(feed.take([source("a", "success", streams(3)), b]))).toEqual(["a:3"]);
  });

  it("skips a refetch's answer, and feeds a failed addon once a retry answers", () => {
    const feed = new StreamFeed();
    feed.take([source("a", "success", streams(2)), source("b", "error")]);
    expect(
      shape(feed.take([source("a", "success", streams(5)), source("b", "success", streams(4))])),
    ).toEqual(["b:4"]);
  });

  it("feeds an addon that answered with no streams nothing", () => {
    expect(new StreamFeed().take([source("a", "success", [])])).toEqual([]);
  });
});

// #98: what ranking is told from the settings.
const profile = (audioLanguages: string[] | null, preferredQuality?: string): ProfileSettings =>
  profileSettings({ audioLanguages, ...(preferredQuality ? { preferredQuality } : {}) });
const device = (changes: Partial<DeviceSettings> = {}): DeviceSettings => ({
  hardwareDecoding: true,
  maxResolution: "auto",
  hdr: "auto",
  dolbyVision: "auto",
  skipTimesOnline: true,
  autoUpdate: true,
  diagnostics: false,
  torrentStreaming: false,
  torrentCacheGB: 5,
  preResolve: false,
  streamSort: "best",
  partyDock: false,
  downloadsDir: "",
  downloadsCapGB: 50,
  downloadsWiFiOnly: true,
  quality: defaultQuality,
  audio: defaultAudio,
  ...changes,
});
// The display reports HDR, or not.
const display = (hdr: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: hdr && query === "(dynamic-range: high)",
  }));

const cap = (maxResolution: string) =>
  rankingPrefs(profile([]), device({ maxResolution })).maxResolution;
const hdrOf = (mode: string) => rankingPrefs(profile([]), device({ hdr: mode })).hdr;
const dolbyVisionOf = (mode: string) =>
  rankingPrefs(profile([]), device({ dolbyVision: mode })).dolbyVision;
const preferred = (preferredQuality: string | undefined, maxResolution = "auto") =>
  rankingPrefs(profile([], preferredQuality), device({ maxResolution })).preferredResolution;

describe("rankingPrefs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is no cap, the display's HDR and no Dolby Vision before anything has loaded", () => {
    display(false);
    expect(rankingPrefs(undefined, undefined)).toEqual({
      languages: [],
      maxResolution: "2160p",
      preferredResolution: null,
      hdr: false,
      dolbyVision: false,
      remembered: null,
    });
    display(true);
    expect(rankingPrefs(undefined, undefined).hdr).toBe(true);
  });

  it("caps the resolution as the device says, and Auto is no cap", () => {
    expect(cap("auto")).toBe("2160p");
    expect(cap("2160p")).toBe("2160p");
    expect(cap("1080p")).toBe("1080p");
    expect(cap("720p")).toBe("720p");
    // A value this build doesn't know is no cap, not an error.
    expect(cap("")).toBe("2160p");
    expect(cap("8k")).toBe("2160p");
  });

  // The profile's preferred quality is soft; the device's cap is a hard limit.
  it("takes the profile's preferred quality, unless the cap is below it", () => {
    expect(preferred("2160p")).toBe("2160p");
    expect(preferred("1080p")).toBe("1080p");
    expect(preferred("720p")).toBe("720p");
    // "best", nothing loaded yet, and a value this build doesn't know: the
    // highest under the cap is already first, so it asks for nothing.
    expect(preferred("best")).toBeNull();
    expect(preferred(undefined)).toBeNull();
    expect(preferred("8k")).toBeNull();
    // Over the cap, the cap decides on its own.
    expect(preferred("2160p", "1080p")).toBeNull();
    expect(preferred("1080p", "1080p")).toBe("1080p");
    expect(preferred("720p", "1080p")).toBe("720p");
  });

  it("follows the display for HDR on Auto, and the setting otherwise", () => {
    display(true);
    expect(hdrOf("auto")).toBe(true);
    expect(hdrOf("off")).toBe(false);
    display(false);
    expect(hdrOf("auto")).toBe(false);
    expect(hdrOf("on")).toBe(true);
  });

  it("leaves Dolby Vision off on Auto, whatever the display says", () => {
    display(true);
    expect(dolbyVisionOf("auto")).toBe(false);
    expect(dolbyVisionOf("off")).toBe(false);
    expect(dolbyVisionOf("on")).toBe(true);
  });

  it("passes the audio languages on in order, and none for null", () => {
    expect(rankingPrefs(profile(["ja", "en"]), device()).languages).toEqual(["ja", "en"]);
    expect(rankingPrefs(profile(null), device()).languages).toEqual([]);
  });

  it("carries the remembered source", () => {
    const remembered = { source: "https://torrentio.example/", resolution: "1080p", group: "PSA" };
    expect(rankingPrefs(profile([]), device(), remembered).remembered).toBe(remembered);
  });
});
