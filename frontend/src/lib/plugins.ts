import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";

import type { Plugin, Query, Stream as PluginStream } from "@bindings/plugins";
import { Service as Plugins } from "@bindings/plugins";
import type { ContentType, Meta, Stream } from "@/lib/addon-protocol";
import { videoNumbers } from "@/lib/ranking";
import { tmdbRef, useTmdbId } from "@/lib/tmdb";

// Nuvio JS plugins (#56, ADR-0043): each is asked for a film's or an
// episode's streams through Go, which runs it in a sandbox, and its answer
// becomes ordinary Stream objects, so the ranking engine (#51), the picker
// (#52) and resolving (#53) treat them as one more addon. Plugins ask by
// TMDB id, so a title without one (no `moviedb_id`, no `tmdb:` id and no
// TMDB key to look its IMDb id up) isn't asked. Plugin stream URLs are
// scraped links: never log them.

export type { Plugin };

// A plugin's answers are fed to ranking under this source, as an addon's
// are under its URL.
export const pluginSource = (plugin: Plugin) => `plugin:${plugin.id}`;
export const isPluginSource = (source: string) => source.startsWith("plugin:");

const minute = 60 * 1000;

// The plugins to ask. Off by default, so none until plugin management (#57)
// keeps a list; a dev build lists $SINAG_DEV_PLUGINS's.
export const installedPluginsQuery = queryOptions({
  queryKey: ["plugins", "installed"],
  queryFn: async () => (await Plugins.Installed()) ?? [],
  staleTime: 5 * minute,
});

export type PluginErrorKind =
  | "timeout"
  | "memory"
  | "failed"
  | "bad_answer"
  | "stalled"
  | "crashed"
  | "invalid_plugin"
  | "unreachable";

const messages: Record<PluginErrorKind, string> = {
  timeout: "The plugin didn’t answer.",
  memory: "The plugin used too much memory.",
  failed: "The plugin failed.",
  bad_answer: "The plugin answered something Sinag can’t read.",
  stalled: "The plugin stopped without answering.",
  crashed: "The plugin stopped unexpectedly.",
  invalid_plugin: "This plugin can’t run in Sinag.",
  unreachable: "The plugin couldn’t be downloaded.",
};

// A plugin call that failed, by internal/plugins' code. The message is for
// the user and says nothing the plugin wrote.
export class PluginError extends Error {
  readonly kind: PluginErrorKind;

  constructor(kind: PluginErrorKind) {
    super(messages[kind]);
    this.name = "PluginError";
    this.kind = kind;
  }
}

function pluginError(error: unknown): PluginError {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return new PluginError(isKind(code) ? code : "failed");
}

const isKind = (code: unknown): code is PluginErrorKind =>
  typeof code === "string" && Object.hasOwn(messages, code);

// What a plugin is asked for a film or an episode: its TMDB id, "movie" or
// "tv", and the episode's season and number from the video id. Undefined
// when there's no TMDB id, or an episode's numbers aren't in its id.
export function pluginQuery(
  type: ContentType,
  video: string,
  tmdb: { tmdb: number; media: "movie" | "tv" } | null | undefined,
): Query | undefined {
  if (!tmdb) return undefined;
  if (type === "movie" || tmdb.media === "movie") {
    return { tmdbId: String(tmdb.tmdb), mediaType: "movie", season: 0, episode: 0 };
  }
  const { season, episode } = videoNumbers(video);
  if (season === undefined || episode === undefined) return undefined;
  return { tmdbId: String(tmdb.tmdb), mediaType: "tv", season, episode };
}

// Whether a plugin answers for a kind of title, as its manifest says.
export function serves(plugin: Plugin, media: string): boolean {
  const types = (plugin.supportedTypes ?? []).map((t) => t.toLowerCase());
  if (types.length === 0) return true;
  return (
    types.includes(media) ||
    (media === "tv" && (types.includes("series") || types.includes("anime")))
  );
}

const units: Record<string, number> = { B: 1, KB: 2 ** 10, MB: 2 ** 20, GB: 2 ** 30, TB: 2 ** 40 };

// "2.5 GB" → bytes.
export function sizeBytes(size: string): number | undefined {
  const m = /^\s*([\d.,]+)\s*(B|KB|MB|GB|TB)\b/i.exec(size);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * units[m[2]!.toUpperCase()]!) : undefined;
}

// A plugin's stream as an addon would send it: the site and quality as the
// name, the title and size as the description (with the 💾 the ranking
// parser reads), and the headers to play it with as proxy headers.
export function toStream(plugin: Plugin, stream: PluginStream): Stream {
  const name = [stream.name || plugin.name, stream.quality].filter(Boolean).join("\n");
  const description = [stream.title, stream.size && `💾 ${stream.size}`].filter(Boolean).join("\n");
  const videoSize = stream.size ? sizeBytes(stream.size) : undefined;
  const pairs = Object.entries(stream.headers ?? {}).filter(
    (pair): pair is [string, string] => typeof pair[1] === "string",
  );
  const headers = pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
  return {
    name,
    ...(description && { description }),
    url: stream.url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `sinag-plugin-${plugin.id}`,
      ...(videoSize && { videoSize }),
      ...(headers && { proxyHeaders: { request: headers } }),
    },
  };
}

// One plugin's streams for a query. Not retried or kept on disk; leaving
// the picker cancels the call, which kills its sandbox.
export const pluginStreamsQuery = (plugin: Plugin, query: Query) =>
  queryOptions({
    queryKey: ["plugin-streams", plugin.id, plugin.version, plugin.url, query],
    queryFn: async ({ signal }): Promise<Stream[]> => {
      const call = Plugins.Streams(plugin, query);
      const cancel = () => void call.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return ((await call) ?? []).map((stream) => toStream(plugin, stream));
      } catch (error) {
        throw pluginError(error);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    staleTime: 5 * minute,
    gcTime: 30 * minute,
    retry: false,
  });

// The installed plugins that serve a title, and what to ask them. `query`
// is undefined (and `loading` false) when the title can't be asked for by
// TMDB id; `loading` is true while the list or the TMDB lookup is.
export function usePluginTargets(
  type: ContentType,
  id: string,
  video: string,
  meta: Meta | undefined,
) {
  const installed = useQuery(installedPluginsQuery);
  const plugins = installed.data ?? [];
  const tmdb = useTmdbId(plugins.length > 0 ? tmdbRef(type, id, meta) : undefined);
  const query = pluginQuery(type, video, tmdb);
  return {
    plugins: query ? plugins.filter((plugin) => serves(plugin, query.mediaType)) : [],
    query,
    loading: installed.isPending || (plugins.length > 0 && tmdb === undefined),
  };
}

// Each plugin's state for the query, in the installed order.
export function usePluginStreams(plugins: readonly Plugin[], query: Query | undefined) {
  return useQueries({
    queries: query ? plugins.map((plugin) => pluginStreamsQuery(plugin, query)) : [],
  });
}
