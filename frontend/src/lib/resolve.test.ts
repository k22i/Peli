import { describe, expect, it, vi } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";
import { candidate, titleContext, type Candidate } from "@/lib/ranking";
import {
  attempts,
  failureMessage,
  PlayError,
  resolvePick,
  sameStream,
  type Resolver,
  type Source,
} from "@/lib/resolve";
import type { TorrentOpener } from "@/lib/torrent";

vi.mock("@bindings/streams", () => ({ Service: { Resolve: vi.fn<() => void>() } }));
vi.mock("@bindings/torrent", () => ({ Service: { Open: vi.fn<() => void>() } }));

const torrentio = "https://torrentio.strem.fun/manifest.json";
const comet = "https://comet.example/manifest.json";
const peerflix = "https://peerflix.example/manifest.json";
const ctx = titleContext("movie", "tt0111161", undefined, "The Shawshank Redemption");
const file = "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv";
const hash = "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6";

// A Torrentio debrid stream for `file`, cached ("+") or not (" download").
const debrid = (marker: string, key = "KEY"): Stream => ({
  name: `[TB${marker}] Torrentio\n1080p`,
  title: `${file}\n👤 20 💾 2.1 GB ⚙️ Tracker`,
  url: `https://torrentio.strem.fun/resolve/torbox/${key}/${hash}/null/0/${file}`,
});
const p2p: Stream = {
  name: "Peerflix\n1080p",
  title: `${file}\n👤 20 💾 2.1 GB`,
  infoHash: hash,
  fileIdx: 0,
};
const torrent = (infoHash: string): Stream => ({ ...p2p, infoHash });

function pick(stream: Stream, ...alternates: { source: string; stream: Stream }[]): Candidate {
  return {
    ...candidate(torrentio, stream, 0, ctx),
    alternates: alternates.map((alternate, i) => ({
      source: alternate.source,
      stream: alternate.stream,
      seq: i + 1,
    })),
  };
}

const source = (url: string): Source => ({
  url: `${url}#cdn`,
  origin: url,
  headers: {},
  userAgent: "Sinag/test",
  contentType: "video/x-matroska",
  size: 2_100_000_000,
});

const goError = (code: string) => new Error("call failed", { cause: { code } });

// A resolver answering by URL: a Source, or a failure code.
function resolver(answers: Record<string, string | null>) {
  return vi.fn<Resolver>(async (url) => {
    const code = answers[url];
    if (code === undefined) throw goError("unreachable");
    if (code !== null) throw goError(code);
    return source(url);
  });
}

type Refresh = (source: string) => Promise<readonly Stream[]>;

// A torrent engine answering by info hash: a Source, or a failure code.
function opener(answers: Record<string, string | null>) {
  return vi.fn<TorrentOpener>(async (request) => {
    const code = answers[request.infoHash];
    if (code === undefined) throw goError("disabled");
    if (code !== null) throw goError(code);
    return {
      url: `http://127.0.0.1:1234/secret/${request.infoHash}/0/film.mkv`,
      origin: `magnet:?xt=urn:btih:${request.infoHash}`,
      headers: {},
      userAgent: "",
      contentType: "video/x-matroska",
      size: 2_100_000_000,
    };
  });
}

const options = (
  resolve: Resolver,
  refresh = vi.fn<Refresh>(async () => []),
  openTorrent = opener({}),
) => ({
  resolve,
  refresh,
  openTorrent,
  signal: new AbortController().signal,
});

describe("resolvePick", () => {
  it("resolves the pick with its addon's headers", async () => {
    const stream: Stream = {
      ...debrid("+"),
      behaviorHints: { proxyHeaders: { request: { Referer: "https://addon.example/" } } },
    };
    const resolve = resolver({ [stream.url!]: null });

    const got = await resolvePick(pick(stream), options(resolve));

    expect(got.source.url).toBe(`${stream.url}#cdn`);
    expect(got.attempt).toEqual({ source: torrentio, stream });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(
      stream.url,
      { Referer: "https://addon.example/" },
      expect.any(AbortSignal),
    );
  });

  it("tries the other copies in order when the pick won't play", async () => {
    const own = debrid("+", "OWN");
    const second = { source: comet, stream: { ...debrid("+", "SECOND"), name: "Comet" } };
    const third = { source: torrentio, stream: debrid("+", "THIRD") };
    const resolve = resolver({
      [own.url!]: "failed",
      [second.stream.url!]: "unavailable",
      [third.stream.url!]: null,
    });

    const got = await resolvePick(pick(own, second, third), options(resolve));

    expect(got.attempt).toEqual(third);
    expect(resolve.mock.calls.map(([url]) => url)).toEqual([
      own.url,
      second.stream.url,
      third.stream.url,
    ]);
  });

  it("says why the pick itself won't play, naming its debrid service", async () => {
    const own = debrid(" download");
    const other = { source: comet, stream: debrid("+", "OTHER") };
    const resolve = resolver({ [own.url!]: "caching", [other.stream.url!]: "expired" });

    const error = await resolvePick(pick(own, other), options(resolve)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlayError);
    expect(error).toMatchObject({
      kind: "caching",
      debrid: "TB",
      message: "TorBox is still downloading this",
    });
  });

  it("streams a torrent through the engine, with its file and trackers", async () => {
    const stream: Stream = {
      ...p2p,
      fileIdx: 3,
      sources: ["tracker:udp://tracker.example:1337/announce", `dht:${hash}`],
      behaviorHints: { filename: file },
    };
    const open = opener({ [hash]: null });

    const got = await resolvePick(pick(stream), options(resolver({}), undefined, open));

    expect(open).toHaveBeenCalledExactlyOnceWith(
      {
        infoHash: hash,
        fileIdx: 3,
        fileName: file,
        sources: ["tracker:udp://tracker.example:1337/announce", `dht:${hash}`],
      },
      expect.any(AbortSignal),
    );
    expect(got.source.origin).toBe(`magnet:?xt=urn:btih:${hash}`);
    expect(got.attempt.stream).toBe(stream);
  });

  it("plays a copy with a link before any torrent, even the pick", async () => {
    const other = { source: torrentio, stream: debrid("+") };
    const resolve = resolver({ [other.stream.url!]: null });
    const open = opener({ [hash]: null });

    const got = await resolvePick(
      { ...pick(p2p, other), source: peerflix },
      options(resolve, undefined, open),
    );

    expect(got.attempt).toEqual(other);
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to the torrent when every link fails", async () => {
    const uncached = { source: comet, stream: debrid(" download", "X") };
    const resolve = resolver({ [uncached.stream.url!]: "caching" });
    const open = opener({ [hash]: null });

    const got = await resolvePick(pick(p2p, uncached), options(resolve, undefined, open));

    expect(resolve).toHaveBeenCalledOnce();
    expect(got.attempt.stream).toBe(p2p);
  });

  it("says torrent streaming is off, unless a copy with a link failed", async () => {
    const resolve = resolver({});
    await expect(resolvePick(pick(p2p), options(resolve))).rejects.toMatchObject({
      kind: "torrent",
      message: "Torrent streaming is off",
    });
    // A copy with a link that failed says more.
    await expect(
      resolvePick(pick(p2p, { source: comet, stream: debrid(" download", "X") }), options(resolve)),
    ).rejects.toMatchObject({ kind: "unreachable" });
    await expect(resolvePick(pick({ ytId: "abc" }), options(resolve))).rejects.toMatchObject({
      kind: "unsupported",
    });
  });

  it("tries two torrents at most, and gives the pick's own failure", async () => {
    const [a, b, c] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const open = opener({ [a]: "no_peers", [b]: "no_file", [c]: null });

    const tried = pick(
      torrent(a),
      { source: peerflix, stream: torrent(b) },
      { source: peerflix, stream: torrent(c) },
    );
    await expect(resolvePick(tried, options(resolver({}), undefined, open))).rejects.toMatchObject({
      kind: "no_peers",
      message: "No one is sharing this torrent",
    });
    expect(open.mock.calls.map(([request]) => request.infoHash)).toEqual([a, b]);

    // Off for one is off for all.
    const off = opener({});
    await expect(
      resolvePick(
        pick(torrent(a), { source: peerflix, stream: torrent(b) }),
        options(resolver({}), undefined, off),
      ),
    ).rejects.toMatchObject({ kind: "torrent" });
    expect(off).toHaveBeenCalledOnce();

    await expect(
      resolvePick(pick(torrent(a)), options(resolver({}), undefined, opener({ [a]: "boom" }))),
    ).rejects.toMatchObject({ kind: "torrent_failed" });
  });

  it("asks the addon again when the link has expired, and plays the new link", async () => {
    const old = debrid("+", "OLD");
    const fresh = debrid("+", "NEW");
    const resolve = resolver({ [old.url!]: "expired", [fresh.url!]: null });
    // Another file in the same torrent isn't taken for it.
    const another = { ...debrid("+", "NEW"), title: "Extras.1994.1080p.mkv\n💾 1 GB" };
    const refresh = vi.fn<Refresh>(async () => [another, fresh]);

    const got = await resolvePick(pick(old), options(resolve, refresh));

    expect(refresh).toHaveBeenCalledExactlyOnceWith(torrentio);
    expect(got.source.url).toBe(`${fresh.url}#cdn`);
    expect(got.attempt.stream).toBe(fresh);
  });

  it("gives up on an expired link the addon sends again unchanged", async () => {
    const old = debrid("+");
    const resolve = resolver({ [old.url!]: "expired" });
    const refresh = vi.fn<Refresh>(async () => [old]);

    await expect(resolvePick(pick(old), options(resolve, refresh))).rejects.toMatchObject({
      kind: "expired",
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("stops once aborted", async () => {
    const own = debrid("+", "OWN");
    const other = { source: comet, stream: debrid("+", "OTHER") };
    const controller = new AbortController();
    const resolve = vi.fn<Resolver>(async () => {
      controller.abort();
      throw goError("unreachable");
    });

    await expect(
      resolvePick(pick(own, other), {
        resolve,
        refresh: async () => [],
        signal: controller.signal,
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("takes an error without a code for an unreachable link", async () => {
    const own = debrid("+");
    const resolve = vi.fn<Resolver>(async () => {
      throw new Error("Wails call failed");
    });
    await expect(resolvePick(pick(own), options(resolve))).rejects.toMatchObject({
      kind: "unreachable",
    });
  });
});

describe("attempts", () => {
  it("is the pick, then its alternates", () => {
    const other = { source: comet, stream: debrid("+", "OTHER") };
    expect(attempts(pick(debrid("+"), other))).toEqual([
      { source: torrentio, stream: debrid("+") },
      other,
    ]);
  });
});

describe("sameStream", () => {
  it("matches the same torrent and file across answers, whatever the link", () => {
    expect(sameStream(debrid("+", "NEW"), debrid("+", "OLD"))).toBe(true);
    expect(sameStream({ ...debrid("+"), title: "Other.File.1080p.mkv" }, debrid("+"))).toBe(false);
  });

  it("matches a stream without a torrent by its text", () => {
    const direct: Stream = { name: "HTTP\n1080p", description: file, url: "https://cdn/1" };
    expect(sameStream({ ...direct, url: "https://cdn/2" }, direct)).toBe(true);
    expect(sameStream({ ...direct, description: "Another.mkv" }, direct)).toBe(false);
  });
});

describe("failureMessage", () => {
  it("names the service when the stream says which, and a stand-in when not", () => {
    expect(failureMessage("denied", "AD").title).toBe("AllDebrid refused the stream");
    expect(failureMessage("caching", null).title).toBe(
      "Your debrid service is still downloading this",
    );
    expect(failureMessage("redirects", null)).toEqual(failureMessage("unreachable", null));
  });
});
