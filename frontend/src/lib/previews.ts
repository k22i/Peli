import { Events } from "@wailsio/runtime";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Thumb } from "@bindings/previews";
import { Service as Previews } from "@bindings/previews";
import type { Source } from "@bindings/streams";
import type { Stream } from "@/lib/addon-protocol";
import { isDownloadSource } from "@/lib/playback";
import { isIOS } from "@/lib/platform";
import { latestOnly, type Watching } from "@/lib/player";
import { parseStream } from "@/lib/ranking";
import { wailsResolver } from "@/lib/resolve";
import type { DeviceSettings } from "@/lib/settings";
import { useStreamAddons, useStreams } from "@/lib/streams";
import { isTorrentSource } from "@/lib/torrent";

// Seek-bar previews (docs/spikes/seek-previews.md): a thumbnail every
// ten seconds of the file that plays, made by Go's internal/previews from a
// second, headless libmpv and sent back as small JPEGs. This is the player
// screen's side of it: ask for the bucket under the pointer, and show the
// nearest thumbnail already made until the right one arrives, so the bar
// never sits empty.
//
// Debrid streams only, the user's rule: a second reader on a torrent makes
// the swarm serve pieces the player isn't playing, competing with playback
// and churning the FIFO cache, and a plain link has nothing cached to read
// from gently. Stream URLs can embed the user's debrid key: nothing here
// logs a stream or a Source.

export const bucketSeconds = 10;

// How far a made thumbnail may be from the bucket asked for, to stand in
// dimmed while the right one is made.
const nearestWithin = 60;

// One thumbnail as the seek bar shows it. `exact` is false for a
// neighbouring bucket's, which the bar dims: the picture is close, not right.
export type PreviewImage = { url: string; w: number; h: number; exact: boolean };

// What the seek bar asks for and shows. `want` asks for the bucket a time
// falls in, and does nothing when previews are off; `near` is what to show
// for a time now.
export type SeekPreviews = {
  near: (seconds: number) => PreviewImage | undefined;
  want: (seconds: number) => void;
};

// The bucket a time falls in: its start in seconds, a multiple of ten.
export function bucketOf(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.floor(seconds / bucketSeconds) * bucketSeconds);
}

// What to show for a time: its own bucket's thumbnail, else the closest one
// made within a minute of it, else nothing (the bar shows the time alone).
export function nearestThumb(
  thumbs: ReadonlyMap<number, Thumb>,
  seconds: number,
): PreviewImage | undefined {
  const bucket = bucketOf(seconds);
  const exact = thumbs.get(bucket);
  if (exact) return { url: exact.url, w: exact.w, h: exact.h, exact: true };
  let closest: { thumb: Thumb; from: number } | undefined;
  for (const thumb of thumbs.values()) {
    const from = Math.abs(bucketOf(thumb.at) - bucket);
    if (!closest || from < closest.from) closest = { thumb, from };
  }
  if (!closest || closest.from > nearestWithin) return undefined;
  return { url: closest.thumb.url, w: closest.thumb.w, h: closest.thumb.h, exact: false };
}

// Whether previews are possible for what plays. Debrid streams only (the
// user's rule): a torrent would have a second reader pulling pieces from the
// swarm, and neither a download nor a plain link is a file on a debrid
// service that may be read a few keyframes at a time. A stream whose cache
// marker says nothing is a P2P one, which comes to the same thing.
export function isPreviewable(stream: Stream | undefined, source: Source | undefined): boolean {
  if (!source || !stream?.url) return false;
  if (isTorrentSource(source) || isDownloadSource(source)) return false;
  const parsed = parseStream(stream);
  return parsed.debrid !== null && parsed.cached !== false;
}

// Previews from a smaller copy of the same release. A thumbnail is 320 px
// wide, so a 2 GB 1080p encode makes the picture a 60 GB remux does for a
// fraction of the bytes. Off by default, since a copy has to be resolved
// first and that adds its torrent to the user's debrid list.
//
// The rules, in order (docs/spikes/seek-previews.md, "A smaller release of
// the same title"):
//  - Only for a big file, 5 GB and up: a smaller one's own thumbnails are
//    cheap already, and its copies are small themselves.
//  - The same debrid service, cached: another service is another account and
//    another download, and an uncached copy starts one.
//  - Not a pack: the file inside it isn't the film that plays.
//  - 720p to 2160p, in AVC or HEVC: AV1 has no hardware decoding on an M1 (or
//    a phone), and the spike's cropped AV1 encodes were the worst offenders
//    for a length that doesn't line up.
//  - 40 % smaller at least, or it saves nothing worth a second resolve.
//
// Go takes the first whose duration is within two seconds of the playing
// file's (internal/previews.DurationTolerance), and the playing file itself
// when none is: a copy cut differently would put every thumbnail at the
// wrong time. SDR comes first, since an HDR copy's keyframes need tone
// mapping (tonemap.go), then the smallest.
const smallerAbove = 5e9;
const smallerShare = 0.6;
const maxSmaller = 3;
const smallerResolutions = new Set<string>(["720p", "1080p", "1440p", "2160p"]);
const smallerCodecs = new Set<string>(["avc", "hevc"]);
// SDR sorts before HDR, as above.
const sdrRank = (hdr: readonly string[]) => (hdr.length === 0 ? 0 : 1);

export function smallerCopies(streams: readonly Stream[], playing: Stream): Stream[] {
  const own = parseStream(playing);
  const ownSize = own.sizeBytes;
  if (ownSize === null || ownSize < smallerAbove) return [];
  const copies = streams.flatMap((stream) => {
    if (!stream.url || stream.url === playing.url) return [];
    const parsed = parseStream(stream);
    const fits =
      parsed.debrid !== null &&
      parsed.debrid === own.debrid &&
      parsed.cached === true &&
      !parsed.pack &&
      parsed.resolution !== null &&
      smallerResolutions.has(parsed.resolution) &&
      parsed.videoCodec !== null &&
      smallerCodecs.has(parsed.videoCodec) &&
      parsed.sizeBytes !== null &&
      parsed.sizeBytes <= ownSize * smallerShare;
    return fits ? [{ stream, parsed }] : [];
  });
  return copies
    .toSorted(
      (a, b) =>
        sdrRank(a.parsed.hdr) - sdrRank(b.parsed.hdr) ||
        (a.parsed.sizeBytes ?? 0) - (b.parsed.sizeBytes ?? 0),
    )
    .slice(0, maxSmaller)
    .map((copy) => copy.stream);
}

// The thumbnails made so far, by bucket, and the copies to make more from:
// empty until there are some. Shared as they are, so showing none twice is
// the same value and doesn't re-render.
const noThumbs: ReadonlyMap<number, Thumb> = new Map();
const noStreams: readonly Stream[] = [];
const noSources: readonly Source[] = [];

// State kept with the key it belongs to: another file's thumbnails are the
// wrong picture and another file's links the wrong film's, so each render
// shows them only while their key is its own, instead of an effect clearing
// the last file's after a render that showed it.
type ThumbsForKey = { key: string; map: ReadonlyMap<number, Thumb> };
type CopiesForKey = { key: string; sources: readonly Source[] };
const noThumbsForKey: ThumbsForKey = { key: "", map: noThumbs };
const noCopiesForKey: CopiesForKey = { key: "", sources: noSources };

// Go's event for a thumbnail the background fill made, carrying a Thumb.
const thumbEvent = "previews:thumb";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Whether an event's payload is a thumbnail: the bridge hands JavaScript
// whatever Go sent, and only Go's own Thumb is a picture to show.
const isThumb = (value: unknown): value is Thumb =>
  isRecord(value) &&
  typeof value["at"] === "number" &&
  typeof value["w"] === "number" &&
  typeof value["h"] === "number" &&
  typeof value["url"] === "string";

// The thumbnails with one bucket's in them, for the key it belongs to: a
// thumbnail made for another file starts from an empty map rather than
// mixing with this one's. A new map, since the old one is what the last
// render showed.
const withThumb = (held: ThumbsForKey, key: string, thumb: Thumb): ThumbsForKey => {
  const next = new Map(held.key === key ? held.map : noThumbs);
  next.set(bucketOf(thumb.at), thumb);
  return { key, map: next };
};

// The seek bar's previews for one file while the player screen is mounted.
// `want` is called on hover and while dragging, `near` on every render.
export function useSeekPreviews(input: {
  source: Source | undefined;
  stream: Stream | undefined;
  duration: number;
  watching: Watching | undefined;
  device: DeviceSettings | undefined;
  enabled: boolean;
}): SeekPreviews {
  const { source, stream, duration, watching, device, enabled } = input;
  // On once there is a file to preview, its stream, the setting (on unless
  // this device turned it off) and a length to divide into buckets: the
  // player knows that a moment after load.
  const on =
    enabled && device?.seekPreviews !== false && isPreviewable(stream, source) && duration > 0;
  const fromSmaller = on && device?.previewsFromSmaller === true;
  // Asked whether or not they're wanted, so a setting that flips doesn't
  // change the page's hooks. No profile yet, or no copies wanted, asks
  // nothing.
  const { addons } = useStreamAddons(watching?.profileId ?? 0);
  const sources = useStreams(
    fromSmaller ? addons : [],
    watching?.contentType ?? "",
    watching?.videoId ?? "",
  );

  const lastAsked = useRef<number | undefined>(undefined);

  // The file that plays and its length in whole seconds, as the player
  // reports that in fractions: what the copies and the thumbnails are keyed
  // by.
  const playingUrl = source?.url ?? "";
  const wholeSeconds = Math.round(duration);

  const waiting = sources.some((asked) => asked.status === "pending");
  const found =
    fromSmaller && !waiting && stream
      ? smallerCopies(
          sources.flatMap((asked) => asked.streams ?? []),
          stream,
        )
      : noStreams;
  const copiesKey =
    found.length === 0 ? "" : `${playingUrl}\n${found.map((copy) => copy.url).join("\n")}`;

  // The smaller copies to make previews from, once resolved into links, and
  // the key they were resolved for: a link resolved for another file (or
  // another pick) is the wrong film's, so it counts only while it is the key
  // this render asks for.
  const [copiesForKey, setCopiesForKey] = useState<CopiesForKey>(noCopiesForKey);
  const smaller = copiesForKey.key === copiesKey ? copiesForKey.sources : noSources;

  // What a bucket, and so a thumbnail, belongs to: the file, its length, the
  // copies Go reads frames from instead, and whether previews are on at all.
  // The same link again keeps the thumbnails already made.
  const smallerUrls = smaller.map((copy) => copy.url).join("\n");
  const beginKey = `${on ? "on" : "off"}\n${playingUrl}\n${wholeSeconds}\n${smallerUrls}`;

  // The thumbnails made so far, by bucket, and the key they were made for:
  // another file's are the wrong picture, and a file left behind whose
  // previews are coming back starts from nothing.
  const [thumbsForKey, setThumbsForKey] = useState<ThumbsForKey>(noThumbsForKey);
  const thumbs = thumbsForKey.key === beginKey ? thumbsForKey.map : noThumbs;

  // What the effects and a hover read, as the last render had it. Pages hand
  // these in afresh each render, and a new object with the same file in it
  // must not restart Go's work or queue the same bucket twice.
  const newest = useRef({ beginKey, source, duration, smaller, found, on, thumbs });
  useLayoutEffect(() => {
    newest.current = { beginKey, source, duration, smaller, found, on, thumbs };
  });

  // Resolve the copies into links, which Go reads frames from in place of the
  // big file: one at a time, since each resolve can open the file on the
  // debrid service. Without copies Go uses what plays.
  useEffect(() => {
    if (!copiesKey) return undefined;
    const aborter = new AbortController();
    let live = true;
    const resolveAll = async (signal: AbortSignal): Promise<Source[]> => {
      const candidates = newest.current.found;
      const copies: Source[] = [];
      for (const candidate of candidates) {
        if (!candidate.url) continue;
        try {
          // oxlint-disable-next-line no-await-in-loop
          const copy = await wailsResolver(
            candidate.url,
            candidate.behaviorHints?.proxyHeaders?.request ?? {},
            signal,
          );
          copies.push(copy);
        } catch {
          // A copy the service won't open this time is simply not offered;
          // the playing file's own thumbnails are the ones that matter.
          if (signal.aborted) return copies;
        }
      }
      return copies;
    };
    void resolveAll(aborter.signal).then((copies) => {
      if (live && copies.length > 0) setCopiesForKey({ key: copiesKey, sources: copies });
    });
    return () => {
      live = false;
      aborter.abort();
    };
  }, [copiesKey]);

  // Begin a file: the buckets start over, and Go opens what plays on the
  // first ask rather than now. Keyed on the file, its length in whole
  // seconds (the player reports it in fractions) and the copies found for it
  // (beginKey), so the same link again keeps the thumbnails already made.
  useEffect(() => {
    lastAsked.current = undefined;
    const playing = newest.current.source;
    // Nothing to preview, or this run is keyed for another file than the one
    // the ref has: there is nothing to begin.
    if (!on || !playing || playing.url !== playingUrl) return undefined;
    void Previews.Begin({
      playing,
      smaller: [...smaller],
      // Go compares this with a smaller copy's own length (within two
      // seconds) and spreads the fill over it, so whole seconds do.
      duration: wholeSeconds,
      // No background fill on a phone: the data and the memory are the
      // player's (docs/spikes/seek-previews.md).
      fill: !isIOS(),
    }).catch(() => {
      // Previews are a nicety: the bar then shows the time alone.
    });
    return () => {
      void Previews.End().catch(() => {});
    };
  }, [on, playingUrl, wholeSeconds, smaller]);

  // The background fill's thumbnails, spread over the whole film.
  useEffect(() => {
    if (!on) return undefined;
    return Events.On(thumbEvent, (event) => {
      const thumb = event.data;
      if (!isThumb(thumb)) return;
      setThumbsForKey((held) => withThumb(held, beginKey, thumb));
    });
  }, [on, beginKey]);

  // One ask at a time, the newest next: Go makes them one at a time and
  // replaces what's queued, and a drag asks several times a second. A
  // rejection is dropped (latestOnly's own catch): the bucket is unavailable
  // (the CDN is pushing back) or was replaced by a newer ask before it ran,
  // and the bar keeps the nearest thumbnail it has either way.
  const [ask] = useState(() =>
    latestOnly<number>((bucket) =>
      Previews.At(bucket).then((thumb) => {
        // Go's session when it arrives is the file playing then, whatever
        // this ask was for, so it is that file's thumbnail.
        const key = newest.current.beginKey;
        setThumbsForKey((held) => withThumb(held, key, thumb));
      }),
    ),
  );
  const want = useCallback(
    (seconds: number) => {
      const { on: live, thumbs: made } = newest.current;
      if (!live) return;
      const bucket = bucketOf(seconds);
      // Made already, or the one asked for last: nothing to queue.
      if (made.has(bucket) || bucket === lastAsked.current) return;
      lastAsked.current = bucket;
      ask(bucket);
    },
    [ask],
  );

  const near = useCallback((seconds: number) => nearestThumb(thumbs, seconds), [thumbs]);
  return { near, want };
}
