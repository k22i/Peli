import type { Source } from "@bindings/streams";
import { Service as Streams } from "@bindings/streams";
import type { Stream } from "@/lib/addon-protocol";
import { dedupKey, parseStream, type Candidate, type Debrid } from "@/lib/ranking";
import { debridNames } from "@/lib/stream-labels";
import { torrentRequest, wailsTorrentOpener, type TorrentOpener } from "@/lib/torrent";

// Resolving a picked stream (#53, ADR-0037): its link asked once through Go
// (internal/streams), with the headers its addon names, to the file the
// player (#60) loads. The pick is tried first, then each other copy of the
// same file in turn (another addon's, another torrent's). A link that has
// expired is asked for again from its addon once. Copies without a link,
// torrents, come after every copy with one, and stream peer to peer through
// internal/torrent (#55, ADR-0040). Stream URLs embed the user's debrid
// key: never log them, or the Source.

export type { Source };

// Why a copy wouldn't play: internal/streams' codes, internal/torrent's,
// and the kinds of stream Sinag can't play.
export type FailureKind =
  | "caching"
  | "denied"
  | "busy"
  | "failed"
  | "expired"
  | "unavailable"
  | "not_video"
  | "unreachable"
  | "timeout"
  | "redirects"
  | "invalid_url"
  // A torrent without a link, with torrent streaming off in Settings.
  | "torrent"
  // internal/torrent's: no peer sent the torrent's file list, it has no
  // video, or the engine couldn't start.
  | "no_peers"
  | "no_file"
  | "torrent_failed"
  // A YouTube id or a link to open elsewhere.
  | "unsupported";

const goCodes: ReadonlySet<string> = new Set<FailureKind>([
  "caching",
  "denied",
  "busy",
  "failed",
  "expired",
  "unavailable",
  "not_video",
  "unreachable",
  "timeout",
  "redirects",
  "invalid_url",
]);

// One copy to try: the addon's URL and its stream.
export type Attempt = { source: string; stream: Stream };

// The pick first, then its alternates, in the engine's order.
export const attempts = (candidate: Candidate): Attempt[] => [
  { source: candidate.source, stream: candidate.stream },
  ...candidate.alternates.map(({ source, stream }) => ({ source, stream })),
];

export class PlayError extends Error {
  readonly kind: FailureKind;
  readonly debrid: Debrid | null;
  readonly description: string;

  constructor(kind: FailureKind, debrid: Debrid | null) {
    const { title, description } = failureMessage(kind, debrid);
    super(title);
    this.name = "PlayError";
    this.kind = kind;
    this.debrid = debrid;
    this.description = description;
  }
}

// What to tell the user, naming the debrid service when the stream says
// which.
export function failureMessage(kind: FailureKind, debrid: Debrid | null): Message {
  return messages[kind](debrid ? debridNames[debrid] : null);
}

type Message = { title: string; description: string };

const messages: Record<FailureKind, (service: string | null) => Message> = {
  caching: (service) => ({
    title: `${service ?? "Your debrid service"} is still downloading this`,
    description:
      "It isn’t cached there yet. Pick a cached stream to watch now, or try this one again in a few minutes.",
  }),
  denied: (service) => ({
    title: `${service ?? "Your debrid service"} refused the stream`,
    description:
      "Check the debrid key in the addon’s settings and that your plan is active, then try again.",
  }),
  busy: (service) => ({
    title: `${service ?? "The service"} has hit a limit`,
    description: "It’s turning down requests for now. Wait a little, or pick another stream.",
  }),
  failed: (service) => ({
    title: `${service ?? "The addon"} can’t play this file`,
    description: "It couldn’t open or fetch the file. Pick another stream.",
  }),
  expired: () => ({
    title: "This stream’s link has expired",
    description:
      "Sinag asked the addon again, but the link still doesn’t work. Pick another stream.",
  }),
  unavailable: (service) => ({
    title: `${service ?? "The stream’s server"} is having problems`,
    description: "Try again in a little while, or pick another stream.",
  }),
  not_video: () => ({
    title: "That link isn’t a video",
    description: "The addon sent a web page instead of the stream. Pick another stream.",
  }),
  timeout: () => ({
    title: "The stream didn’t answer",
    description: "It took too long to start. Try again, or pick another stream.",
  }),
  unreachable: () => unreachable,
  redirects: () => unreachable,
  torrent: () => ({
    title: "Torrent streaming is off",
    description:
      "Turn it on in Settings › Playback to stream torrents peer to peer, or pick a debrid or direct stream.",
  }),
  no_peers: () => ({
    title: "No one is sharing this torrent",
    description: "No peers answered. Pick a stream with more peers, or a debrid or direct one.",
  }),
  no_file: () => ({
    title: "This torrent has no video to play",
    description: "Pick another stream.",
  }),
  torrent_failed: () => ({
    title: "Couldn’t start streaming the torrent",
    description: "Sinag’s torrent engine couldn’t start. Try again, or pick another stream.",
  }),
  invalid_url: () => unsupported,
  unsupported: () => unsupported,
};

const unreachable: Message = {
  title: "Couldn’t reach the stream",
  description: "Check your connection, then try again or pick another stream.",
};

const unsupported: Message = {
  title: "Sinag can’t play this kind of stream",
  description: "Pick another stream.",
};

// Resolves a stream's link, rejecting with a cause of { code } from
// internal/streams. Tests pass their own.
export type Resolver = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<Source>;

export const wailsResolver: Resolver = (url, headers, signal) => {
  const call = Streams.Resolve({ url, headers });
  const cancel = () => void call.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  return call.finally(() => signal.removeEventListener("abort", cancel));
};

export type ResolveOptions = {
  resolve?: Resolver;
  openTorrent?: TorrentOpener;
  // Asks the addon at `source` for the video's streams again, for a fresh
  // link when one has expired.
  refresh: (source: string) => Promise<readonly Stream[]>;
  signal: AbortSignal;
};

export type Resolved = { source: Source; attempt: Attempt };

// Torrents tried for one pick at most: a dead one takes internal/torrent's
// 45 s to give up on.
const maxTorrents = 2;

// Tries each copy of `candidate` in turn and gives the first that resolves:
// those with a link first, as a debrid or direct link starts sooner than
// peers do, then torrents. Rejects with a PlayError for the pick's own
// failure (the copies are only fallbacks), unless the pick is a torrent with
// streaming off and a copy with a link failed: that says more. Rejects with
// the signal's reason once it aborts.
export async function resolvePick(
  candidate: Candidate,
  { resolve = wailsResolver, openTorrent = wailsTorrentOpener, refresh, signal }: ResolveOptions,
): Promise<Resolved> {
  const all = attempts(candidate);
  const linked = all.filter((attempt) => attempt.stream.url);
  const torrents = all.filter((attempt) => !attempt.stream.url && attempt.stream.infoHash);
  const failures = new Map<Attempt, FailureKind>();
  for (const attempt of linked) {
    signal.throwIfAborted();
    // One copy at a time: each resolve can make the debrid service start a
    // download.
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await tryAttempt(attempt.stream.url!, attempt, resolve, refresh, signal);
    if ("source" in outcome) return outcome;
    failures.set(attempt, outcome.failure);
  }
  for (const attempt of torrents.slice(0, maxTorrents)) {
    signal.throwIfAborted();
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await tryTorrent(attempt, openTorrent, signal);
    if ("source" in outcome) return outcome;
    failures.set(attempt, outcome.failure);
    // Off for one is off for all.
    if (outcome.failure === "torrent") break;
  }
  const own = failures.get(all[0]!) ?? (all[0]!.stream.infoHash ? "torrent" : "unsupported");
  const fromLink = linked.map((attempt) => failures.get(attempt)).find(Boolean);
  throw new PlayError(own === "torrent" && fromLink ? fromLink : own, candidate.parsed.debrid);
}

async function tryTorrent(
  attempt: Attempt,
  open: TorrentOpener,
  signal: AbortSignal,
): Promise<Resolved | { failure: FailureKind }> {
  try {
    return { source: await open(torrentRequest(attempt.stream), signal), attempt };
  } catch (error) {
    signal.throwIfAborted();
    return { failure: torrentFailureOf(error) };
  }
}

const torrentCodes: Record<string, FailureKind> = {
  disabled: "torrent",
  no_peers: "no_peers",
  no_file: "no_file",
  invalid: "unsupported",
};

function torrentFailureOf(error: unknown): FailureKind {
  const code = codeOf(error);
  return (code ? torrentCodes[code] : undefined) ?? "torrent_failed";
}

async function tryAttempt(
  url: string,
  attempt: Attempt,
  resolve: Resolver,
  refresh: ResolveOptions["refresh"],
  signal: AbortSignal,
): Promise<Resolved | { failure: FailureKind }> {
  const once = async (link: string, stream: Stream) => {
    try {
      return { source: await resolve(link, requestHeaders(stream), signal), attempt };
    } catch (error) {
      signal.throwIfAborted();
      return { failure: failureOf(error) };
    }
  };
  const first = await once(url, attempt.stream);
  if ("source" in first || first.failure !== "expired") return first;

  let fresh: Stream | undefined;
  try {
    fresh = (await refresh(attempt.source)).find((stream) => sameStream(stream, attempt.stream));
  } catch {
    signal.throwIfAborted();
  }
  if (!fresh?.url || fresh.url === url) return first;
  const again = await once(fresh.url, fresh);
  return "source" in again ? { ...again, attempt: { ...attempt, stream: fresh } } : again;
}

const requestHeaders = (stream: Stream) => stream.behaviorHints?.proxyHeaders?.request ?? {};

function failureOf(error: unknown): FailureKind {
  const code = codeOf(error);
  return code && isGoCode(code) ? code : "unreachable";
}

// The code a Go service's MarshalError put in the call's cause.
function codeOf(error: unknown): string | undefined {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return typeof code === "string" ? code : undefined;
}

const isGoCode = (code: string): code is FailureKind => goCodes.has(code);

// The same file in a fresh answer: the same torrent and file when the
// stream says, else the same name and text.
export function sameStream(a: Stream, b: Stream): boolean {
  const key = dedupKey(parseStream(b));
  if (key) return dedupKey(parseStream(a)) === key;
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.behaviorHints?.filename === b.behaviorHints?.filename
  );
}
