import { describe, expect, it, vi } from "vite-plus/test";

import type { LoadedAddon, Manifest, Stream } from "@/lib/addon-protocol";

import { StreamFeed, slices, type StreamSource } from "./streams";

vi.mock("@bindings/addons", () => ({ Service: { Fetch: vi.fn<() => void>() } }));
vi.mock("@bindings/store", () => ({ Service: {} }));

const streams = (count: number, from = 0): Stream[] =>
  Array.from({ length: count }, (_, i) => ({ name: `s${from + i}` }));

const addon = (url: string): LoadedAddon => {
  const manifest: Manifest = {
    id: url,
    name: url,
    version: "1.0.0",
    types: ["movie"],
    resources: [{ name: "stream", types: ["movie"] }],
    catalogs: [],
    behaviorHints: {},
  };
  return { url, manifest };
};

const source = (url: string, status: StreamSource["status"], answer?: Stream[]): StreamSource => ({
  addon: addon(url),
  status,
  streams: answer,
  error: null,
  retry: () => {},
});

const shape = (out: { addon: string; streams: readonly Stream[] }[]) =>
  out.map((slice) => `${slice.addon}:${slice.streams.length}`);

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
