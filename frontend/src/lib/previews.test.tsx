import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Thumb } from "@bindings/previews";
import { Service as Previews } from "@bindings/previews";
import { CancellablePromise } from "@wailsio/runtime";
import type { Source } from "@bindings/streams";
import type { Stream } from "@/lib/addon-protocol";

import { bucketOf, isPreviewable, nearestThumb, smallerCopies, useSeekPreviews } from "./previews";

const hash = "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6";

// A Torrentio stream as it answers: the cache marker in the name ("[TB+]"
// cached, "[TB download]" not), the file that plays and its size in the
// description, as lib/ranking/parse.test.ts builds them.
const torrentio = (
  name: string,
  file: string,
  size: string,
  url = `https://torrentio.example/resolve/torbox/KEY/${hash}/null/0/${file}`,
): Stream => ({
  name,
  description: `${file}\n👤 50 💾 ${size} ⚙️ Tracker`,
  url,
  behaviorHints: { filename: file },
});

// The file that plays for the copies below: a 12.3 GB 4K remux, so its
// copies may be up to 7.4 GB.
const remux = torrentio(
  "[TB+] Torrentio\n4k",
  "Some.Film.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-GRP.mkv",
  "12.3 GB",
);

// A Source as internal/streams.Resolve hands one back.
const source = (origin: string): Source => ({
  url: `${origin}#cdn`,
  origin,
  headers: {},
  userAgent: "Peli/test",
  contentType: "video/x-matroska",
  size: 2_100_000_000,
});

describe("bucketOf", () => {
  it("rounds a time down to its bucket", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(9.9)).toBe(0);
    expect(bucketOf(10)).toBe(10);
    expect(bucketOf(863.7)).toBe(860);
  });

  it("never goes below the start of the file", () => {
    expect(bucketOf(-4)).toBe(0);
    expect(bucketOf(Number.NaN)).toBe(0);
  });
});

const thumb = (at: number): Thumb => ({ at, url: `data:image/jpeg;base64,${at}`, w: 320, h: 180 });
const made = (...ats: number[]) => new Map(ats.map((at) => [at, thumb(at)] as const));

describe("nearestThumb", () => {
  it("takes the bucket's own thumbnail", () => {
    expect(nearestThumb(made(0, 10, 20), 12.5)).toEqual({
      url: thumb(10).url,
      w: 320,
      h: 180,
      exact: true,
    });
  });

  it("stands the closest one in when a bucket isn't made", () => {
    expect(nearestThumb(made(0, 30), 60)).toEqual({
      url: thumb(30).url,
      w: 320,
      h: 180,
      exact: false,
    });
  });

  it("stands in a thumbnail a minute away, but no further", () => {
    expect(nearestThumb(made(0), 60)).toMatchObject({ exact: false });
    expect(nearestThumb(made(0), 70)).toBeUndefined();
  });

  it("shows nothing before there are any", () => {
    expect(nearestThumb(new Map(), 10)).toBeUndefined();
  });
});

describe("isPreviewable", () => {
  const file = "https://torrentio.example/resolve/torbox/KEY/hash/null/0/film.mkv";

  it("previews a cached debrid stream", () => {
    expect(isPreviewable(remux, source(file))).toBe(true);
  });

  it("previews nothing that has to be downloaded first", () => {
    const stale = torrentio(
      "[TB download] Torrentio\n4k",
      "Some.Film.2024.2160p.HEVC.mkv",
      "12.3 GB",
    );
    expect(isPreviewable(stale, source(file))).toBe(false);
  });

  it("previews nothing peer to peer", () => {
    const p2p: Stream = {
      name: "Peerflix\n1080p",
      description: "Some.Film.2024.1080p.WEB-DL.AVC.mkv\n👤 50 💾 4.2 GB",
      infoHash: hash,
      fileIdx: 0,
    };
    expect(isPreviewable(p2p, source(file))).toBe(false);
  });

  it("previews nothing played from a torrent or a download", () => {
    expect(isPreviewable(remux, source(`magnet:?xt=urn:btih:${hash}`))).toBe(false);
    expect(isPreviewable(remux, source("download:11"))).toBe(false);
  });

  it("previews nothing without both a stream and a source", () => {
    expect(isPreviewable(undefined, source(file))).toBe(false);
    expect(isPreviewable(remux, undefined)).toBe(false);
  });
});

describe("smallerCopies", () => {
  it("offers nothing for a file that is small already", () => {
    const small = torrentio(
      "[TB+] Torrentio\n1080p",
      "Some.Film.2024.1080p.WEB-DL.AVC-GRP.mkv",
      "4.2 GB",
    );
    const copy = torrentio(
      "[TB+] Torrentio\n720p",
      "Some.Film.2024.720p.WEB-DL.AVC-GRP.mkv",
      "1.2 GB",
    );
    expect(smallerCopies([copy], small)).toEqual([]);
  });

  it("takes only cached copies from the same debrid service", () => {
    const elsewhere = torrentio(
      "[RD+] Torrentio\n1080p",
      "Some.Film.2024.1080p.WEB-DL.HEVC-RD.mkv",
      "2.8 GB",
    );
    const uncached = torrentio(
      "[TB download] Torrentio\n1080p",
      "Some.Film.2024.1080p.WEB-DL.HEVC-TB.mkv",
      "2.8 GB",
    );
    const mine = torrentio(
      "[TB+] Torrentio\n1080p",
      "Some.Film.2024.1080p.WEB-DL.HEVC-OK.mkv",
      "2.8 GB",
    );
    expect(smallerCopies([elsewhere, uncached, mine], remux)).toEqual([mine]);
  });

  it("takes no AV1, no packs, no low resolutions and nothing too large", () => {
    const av1 = torrentio(
      "[TB+] Torrentio\n1080p",
      "Some.Film.2024.1080p.WEB-DL.AV1-GRP.mkv",
      "2.4 GB",
    );
    const pack = torrentio(
      "[TB+] Torrentio\n1080p",
      "Some.Film.2024.S01.1080p.WEB-DL.HEVC-GRP.mkv",
      "2.6 GB",
    );
    const low = torrentio(
      "[TB+] Torrentio\n480p",
      "Some.Film.2024.480p.WEB-DL.AVC-GRP.mkv",
      "0.6 GB",
    );
    const tooLarge = torrentio(
      "[TB+] Torrentio\n1080p",
      "Some.Film.2024.1080p.WEB-DL.HEVC-BIG.mkv",
      "8.5 GB",
    );
    expect(smallerCopies([av1, pack, low, tooLarge], remux)).toEqual([]);
  });

  it("prefers SDR, then the smallest, and offers three at most", () => {
    const hdr = torrentio(
      "[TB+] Torrentio\n1080p",
      "Some.Film.2024.1080p.WEB-DL.HDR10.HEVC-HDR.mkv",
      "6.1 GB",
    );
    const mid = torrentio(
      "[TB+] Torrentio\n1080p",
      "Some.Film.2024.1080p.WEB-DL.HEVC-MID.mkv",
      "3.4 GB",
    );
    const low = torrentio(
      "[TB+] Torrentio\n720p",
      "Some.Film.2024.720p.WEB-DL.AVC-LOW.mkv",
      "1.8 GB",
    );
    const tiny = torrentio(
      "[TB+] Torrentio\n720p",
      "Some.Film.2024.720p.WEB-DL.HEVC-TINY.mkv",
      "1.2 GB",
    );
    expect(smallerCopies([hdr, mid, low, tiny], remux)).toEqual([tiny, low, mid]);
  });
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);
// Go's answers to At: refused with its error, or still being made.
const rejects = (message: string) => CancellablePromise.reject<Thumb>(new Error(message));
const pending = () => new CancellablePromise<Thumb>(() => {});

// The hook on a cached TorBox remux, with nothing from settings.
const render = () =>
  renderHook(
    () =>
      useSeekPreviews({
        source: source("https://torrentio.example/resolve/torbox/KEY/x"),
        stream: remux,
        duration: 600,
        watching: undefined,
        device: undefined,
        enabled: true,
      }),
    { wrapper },
  );

describe("useSeekPreviews", () => {
  it("shows a loading placeholder while a thumbnail is made", () => {
    vi.mocked(Previews.At).mockReturnValueOnce(pending());
    const { result } = render();
    act(() => result.current.want(125));
    expect(result.current.near(125)).toEqual({
      url: undefined,
      w: 320,
      h: 180,
      exact: false,
      loading: true,
    });
  });

  it("says no preview, and asks no more, once Go stops the file's previews", async () => {
    vi.mocked(Previews.At).mockReturnValueOnce(rejects("previews: unavailable"));
    const { result } = render();
    act(() => result.current.want(125));
    await waitFor(() => expect(result.current.near(125)?.failed).toBe(true));
    expect(result.current.near(400)).toMatchObject({ failed: true });
    expect(result.current.near(400)?.loading).toBeUndefined();
    vi.mocked(Previews.At).mockClear();
    act(() => result.current.want(400));
    expect(Previews.At).not.toHaveBeenCalled();
  });

  it("isn't a failure when a newer ask replaced this one", async () => {
    vi.mocked(Previews.At).mockReturnValueOnce(rejects("previews: replaced by a newer request"));
    const { result } = render();
    act(() => result.current.want(125));
    await act(async () => {});
    expect(result.current.near(125)).toMatchObject({ loading: true });
    expect(result.current.near(125)?.failed).toBeUndefined();
  });

  it("shows nothing when previews are off", () => {
    const { result } = renderHook(
      () =>
        useSeekPreviews({
          source: undefined,
          stream: undefined,
          duration: 600,
          watching: undefined,
          device: undefined,
          enabled: true,
        }),
      { wrapper },
    );
    expect(result.current.near(125)).toBeUndefined();
  });
});
