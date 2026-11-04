import { describe, expect, it, vi } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";

import { StreamFeed, slices, type StreamSource } from "./streams";

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
