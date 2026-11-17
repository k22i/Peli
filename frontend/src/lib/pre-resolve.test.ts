import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";
import {
  preResolvable,
  settleAfter,
  staleAfter,
  usePreResolve,
  type PreResolveOptions,
} from "@/lib/pre-resolve";
import { candidate, titleContext, type Candidate } from "@/lib/ranking";
import type { Resolver, Source } from "@/lib/resolve";

vi.mock("@bindings/streams", () => ({ Service: { Resolve: vi.fn<() => void>() } }));
vi.mock("@bindings/torrent", () => ({ Service: { Open: vi.fn<() => void>() } }));

const torrentio = "https://torrentio.strem.fun/manifest.json";
const ctx = titleContext("movie", "tt0111161", undefined, "The Shawshank Redemption");
const file = (resolution: string) => `The.Shawshank.Redemption.1994.${resolution}.BluRay.x264-GRP.mkv`;

// A Torrentio TorBox stream, cached ("+") or not (" download").
const debrid = (marker: string, resolution = "1080p"): Stream => ({
  name: `[TB${marker}] Torrentio\n${resolution}`,
  title: `${file(resolution)}\n👤 20 💾 2.1 GB ⚙️ Tracker`,
  url: `https://torrentio.strem.fun/resolve/torbox/KEY/${resolution}${marker === "+" ? "a" : "b"}/null/0/${file(resolution)}`,
});

const pick = (stream: Stream, source = torrentio, alternates: Stream[] = []): Candidate => ({
  ...candidate(source, stream, 0, ctx),
  alternates: alternates.map((alternate, i) => ({ source, stream: alternate, seq: i + 1 })),
});

const source = (url: string): Source => ({
  url: `${url}#cdn`,
  origin: url,
  headers: {},
  userAgent: "Peli/test",
  contentType: "video/x-matroska",
  size: 2_100_000_000,
});

let resolve: ReturnType<typeof vi.fn<Resolver>>;
let clock: number;

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  resolve = vi.fn<Resolver>(async (url) => source(url));
});

afterEach(() => {
  vi.useRealTimers();
});

function render(top: Candidate | null, options: Partial<PreResolveOptions> = {}) {
  return renderHook(
    ({ top: best, ...rest }: { top: Candidate | null } & Partial<PreResolveOptions>) =>
      usePreResolve(best, {
        enabled: true,
        answered: true,
        refresh: () => Promise.resolve([]),
        resolve,
        now: () => clock,
        ...rest,
      }),
    { initialProps: { top, ...options } },
  );
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(settleAfter));

describe("which top picks resolve ahead", () => {
  it("is only a cached debrid stream with a link, from an addon", () => {
    expect(preResolvable(pick(debrid("+")))).toBe(true);
    expect(preResolvable(pick(debrid(" download")))).toBe(false);
    // A torrent without a link, and a direct link that says nothing of a
    // debrid cache.
    expect(
      preResolvable(pick({ name: "Peerflix\n1080p", title: file("1080p"), infoHash: "a".repeat(40) })),
    ).toBe(false);
    expect(preResolvable(pick({ name: "Direct\n1080p", url: "https://cdn.example/a.mkv" }))).toBe(
      false,
    );
    // A plugin's stream, even one that says it's cached.
    expect(preResolvable(pick(debrid("+"), "plugin:repo/some"))).toBe(false);
  });
});

describe("resolving the top pick ahead", () => {
  it("does nothing while the setting is off", async () => {
    const top = pick(debrid("+"));
    const { result } = render(top, { enabled: false });
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(resolve).not.toHaveBeenCalled();
    expect(result.current.take(top)).toBeUndefined();
  });

  it("waits for every source to answer, then for the ranking to settle", async () => {
    const top = pick(debrid("+"));
    const { rerender } = render(top, { answered: false });
    await settle();
    expect(resolve).not.toHaveBeenCalled();
    rerender({ top, answered: true });
    await act(() => vi.advanceTimersByTimeAsync(settleAfter - 1));
    expect(resolve).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("resolves only a cached pick, and only the pick, not its copies", async () => {
    const { rerender } = render(pick(debrid(" download")));
    await settle();
    expect(resolve).not.toHaveBeenCalled();

    // The pick fails; its copy isn't tried ahead.
    resolve.mockRejectedValueOnce(new Error("failed", { cause: { code: "failed" } }));
    rerender({ top: pick(debrid("+"), torrentio, [debrid("+", "720p")]) });
    await settle();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]![0]).toBe(debrid("+").url);
  });

  it("gives the resolved link to the same pick, once it's picked", async () => {
    const top = pick(debrid("+"));
    const { result } = render(top);
    await settle();
    // A new Candidate for the same stream, as a re-rank makes.
    const resolved = await result.current.take(pick(debrid("+")));
    expect(resolved?.source).toEqual(source(debrid("+").url!));
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("gives a resolve still out to the pick, rather than asking twice", async () => {
    let answer!: (s: Source) => void;
    resolve.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const top = pick(debrid("+"));
    const { result, rerender } = render(top);
    await settle();
    const early = result.current.take(top);
    expect(early).toBeDefined();
    // The top pick changing now doesn't abort what the pick waits on.
    rerender({ top: pick(debrid("+", "720p")) });
    answer(source("https://cdn.example/a"));
    expect((await early)?.source.url).toBe("https://cdn.example/a#cdn");
  });

  it("aborts and drops it when the top pick changes", async () => {
    let signal!: AbortSignal;
    resolve.mockImplementationOnce(
      (_url, _headers, s) =>
        new Promise((_, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(s.reason));
        }),
    );
    const first = pick(debrid("+"));
    const second = pick(debrid("+", "720p"));
    const { result, rerender } = render(first);
    await settle();
    rerender({ top: second });
    expect(signal.aborted).toBe(true);
    expect(result.current.take(first)).toBeUndefined();
    // The new top pick resolves ahead in its place, once settled.
    await settle();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1]![0]).toBe(second.stream.url);
    expect(result.current.take(second)).toBeDefined();
  });

  it("drops it when the user picks another stream", async () => {
    const top = pick(debrid("+"));
    const { result } = render(top);
    await settle();
    expect(result.current.take(pick(debrid("+", "720p")))).toBeUndefined();
    // Gone: the top pick resolves now when it's picked after all.
    expect(result.current.take(top)).toBeUndefined();
  });

  it("never resolves the same pick ahead twice in one visit", async () => {
    const first = pick(debrid("+"));
    const { rerender } = render(first);
    await settle();
    rerender({ top: pick(debrid("+", "720p")) });
    await settle();
    rerender({ top: first });
    await settle();
    expect(resolve.mock.calls.map(([url]) => url)).toEqual([
      debrid("+").url,
      debrid("+", "720p").url,
    ]);
  });

  it("resolves afresh once the link is stale", async () => {
    const top = pick(debrid("+"));
    const { result } = render(top);
    await settle();
    clock += staleAfter + 1;
    expect(result.current.take(top)).toBeUndefined();
  });

  it("aborts what's still out when the picker is left", async () => {
    let signal!: AbortSignal;
    resolve.mockImplementationOnce(
      (_url, _headers, s) =>
        new Promise((_, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(s.reason));
        }),
    );
    const { unmount } = render(pick(debrid("+")));
    await settle();
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
