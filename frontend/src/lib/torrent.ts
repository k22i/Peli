import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import type { Source } from "@bindings/streams";
import { Service as Torrents, type Request, type Status } from "@bindings/torrent";
import type { Stream } from "@/lib/addon-protocol";
import { formatBytes } from "@/lib/bytes";

// Torrent streaming (#55, ADR-0040): internal/torrent fetches a torrent's
// pieces from peers, those around what the player reads first, and serves
// the file to mpv on a loopback link, so the player loads it like any other
// Source. It's off unless the user turns it on in Settings, since peers see
// their IP address. One torrent plays at a time; leaving the player lets it
// go.

export { Torrents };
export type TorrentStatus = Status;

// The cache sizes Settings offers, in GB (internal/store's
// TorrentCacheSizes).
export const torrentCacheSizes = [2, 5, 10, 20, 50] as const;

// What internal/torrent needs to find a stream's file.
export const torrentRequest = (stream: Stream): Request => ({
  infoHash: stream.infoHash ?? "",
  fileIdx: stream.fileIdx ?? null,
  fileName: stream.behaviorHints?.filename ?? "",
  sources: stream.sources ?? [],
});

// Opens a torrent stream, rejecting with a cause of { code } from
// internal/torrent. Tests pass their own.
export type TorrentOpener = (request: Request, signal: AbortSignal) => Promise<Source>;

export const wailsTorrentOpener: TorrentOpener = (request, signal) => {
  const call = Torrents.Open(request);
  const cancel = () => void call.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  return call.finally(() => signal.removeEventListener("abort", cancel));
};

// A Source internal/torrent serves: its origin is the torrent's magnet link.
export const isTorrentSource = (source: Source | undefined) =>
  source?.origin.startsWith("magnet:") ?? false;

export const torrentStatusQuery = queryOptions({
  queryKey: ["torrent", "status"],
  queryFn: () => Torrents.Status(),
  refetchInterval: 1000,
  staleTime: 0,
  gcTime: 0,
});

// The torrent playing's peers, speed and buffer, once a second while on.
export function useTorrentStatus(on: boolean): TorrentStatus | undefined {
  return useQuery({ ...torrentStatusQuery, enabled: on }).data;
}

// "Finding peers…", or "12 peers · 3.4 MB/s · 48 MB ready".
export function torrentStatusText(status: TorrentStatus): string {
  const peers = status.peers === 1 ? "1 peer" : `${status.peers} peers`;
  if (!status.ready) {
    return status.peers === 0 ? "Finding peers…" : `Getting the file list from ${peers}…`;
  }
  const parts = [peers, `${formatBytes(status.downloadRate)}/s`];
  if (status.ahead > 0) parts.push(`${formatBytes(status.ahead)} ready`);
  return parts.join(" · ");
}

// "940 KB", "3.4 MB", "1.2 GB": decimal units, as disks and speeds count.
// Kept here for the screens that ask lib/torrent; lib/bytes has the function,
// so downloads (#85) show sizes without the torrent bindings.
export { formatBytes };

export const torrentCacheQuery = queryOptions({
  queryKey: ["torrent", "cache"],
  queryFn: () => Torrents.CacheSize(),
  staleTime: 0,
});

// Deletes the cached pieces, but the torrent playing's.
export function useClearTorrentCache() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => Torrents.ClearCache(),
    onError: () => toastManager.add({ type: "error", title: "Couldn’t clear the torrent cache" }),
    onSettled: () => client.invalidateQueries({ queryKey: torrentCacheQuery.queryKey }),
  });
}
