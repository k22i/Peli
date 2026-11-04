import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ContentType, Meta } from "@/lib/addon-protocol";
import { secrets } from "@/lib/secrets";

// The optional TMDB key (#47, ADR-0031): with one, title pages get TMDB's
// logo, backdrop and cast photos for titles TMDB knows. Without one, nothing
// here runs and pages show the addon's details as before. The key lives in
// the keychain (`tmdb.api-key`) and in memory under the "secrets" query key,
// which is never persisted; it is never part of another query's key, so
// TMDB's answers can be kept across restarts without it.

export const tmdbSecret = "tmdb.api-key";

const api = "https://api.themoviedb.org/3";
const images = "https://image.tmdb.org/t/p";
const timeout = 10_000;

// The saved key, or null. A keychain that can't be read (Linux without a
// Secret Service) counts as no key.
export const tmdbKeyQuery = queryOptions({
  queryKey: ["secrets", tmdbSecret],
  queryFn: async () => {
    try {
      return (await secrets.get(tmdbSecret)) ?? null;
    } catch {
      return null;
    }
  },
  staleTime: Number.POSITIVE_INFINITY,
  retry: false,
});

export function useTmdbKey(): string | null | undefined {
  return useQuery(tmdbKeyQuery).data;
}

// Why a TMDB request failed.
export type TmdbErrorKind = "invalid_key" | "key_refused" | "unreachable" | "unavailable";

export class TmdbError extends Error {
  readonly kind: TmdbErrorKind;

  constructor(kind: TmdbErrorKind, message: string) {
    super(message);
    this.name = "TmdbError";
    this.kind = kind;
  }
}

// TMDB gives two kinds of credential: a v3 API key (32 hex characters), sent
// as `api_key`, and a v4 read access token (a JWT), sent as a bearer token.
// Both work on the v3 API.
export function tmdbKeyProblem(key: string): string | undefined {
  if (key === "") return "Enter a key.";
  if (/[^\x21-\x7e]/.test(key) || key.length > 2560) {
    return "A key has no spaces. Paste it again from TMDB’s API settings.";
  }
  return undefined;
}

const isToken = (key: string) => key.startsWith("eyJ");

async function tmdbGet(
  key: string,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(api + path);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isToken(key)) headers["Authorization"] = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);

  const timer = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await fetch(url.href, {
      headers,
      signal: signal ? AbortSignal.any([signal, timer]) : timer,
    });
  } catch {
    if (signal?.aborted) throw signal.reason;
    // Neither the URL nor the error is kept: the URL can hold the key.
    throw new TmdbError("unreachable", "TMDB couldn’t be reached.");
  }
  if (response.status === 401) throw new TmdbError("key_refused", "TMDB refused the key.");
  if (!response.ok) throw new TmdbError("unavailable", `TMDB answered ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new TmdbError("unavailable", "TMDB’s answer couldn’t be read.");
  }
}

// Checks a key with TMDB without saving it.
export async function checkTmdbKey(key: string): Promise<void> {
  const problem = tmdbKeyProblem(key);
  if (problem) throw new TmdbError("invalid_key", problem);
  await tmdbGet(key, "/authentication", {});
}

// Checks the key, then saves it to the keychain. The old key's answers are
// dropped, since a key can change what TMDB returns (its language, say).
export function useSaveTmdbKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      await checkTmdbKey(key);
      await secrets.set(tmdbSecret, key);
      return key;
    },
    onSuccess: (key) => {
      client.setQueryData(tmdbKeyQuery.queryKey, key);
      client.removeQueries({ queryKey: ["tmdb"] });
    },
  });
}

// Removes the key and what TMDB gave, so pages go back to the addon's art.
export function useRemoveTmdbKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => secrets.delete(tmdbSecret),
    onSuccess: () => {
      client.setQueryData(tmdbKeyQuery.queryKey, null);
      client.removeQueries({ queryKey: ["tmdb"] });
    },
  });
}

type Media = "movie" | "tv";

// How to find a title on TMDB: its TMDB id, or its IMDb id to look up.
export type TmdbRef = { tmdb: number; media: Media } | { imdb: string; media: Media | undefined };

const mediaOf = (type: ContentType): Media | undefined =>
  type === "movie" ? "movie" : ["series", "show", "tv", "tvshow"].includes(type) ? "tv" : undefined;

// The id mapping, from the most direct: Cinemeta's `moviedb_id`, an id such
// as `tmdb:1396` (TMDB addons), an `imdb_id` field (Kitsu's anime have one
// when Kitsu maps them) or an IMDb id itself. A title with none of these,
// such as an unmapped Kitsu anime, isn't looked up.
export function tmdbRef(type: ContentType, id: string, meta?: Meta): TmdbRef | undefined {
  const media = mediaOf(type);
  const moviedb = meta?.["moviedb_id"];
  if (media && typeof moviedb === "number" && Number.isInteger(moviedb) && moviedb > 0) {
    return { tmdb: moviedb, media };
  }
  const tmdb = /^tmdb:(\d+)$/.exec(id);
  if (media && tmdb) return { tmdb: Number(tmdb[1]), media };
  const imdb = [id, meta?.["imdb_id"]].find(
    (value): value is string => typeof value === "string" && /^tt\d+$/.test(value),
  );
  if (imdb) return { imdb, media };
  return undefined;
}

// A cast member with a photo, as TMDB lists them.
export type CastMember = { id: number; name: string; character?: string; photo?: string };

// What TMDB adds to a title page.
export type TmdbArt = {
  logo?: string;
  backdrop?: string;
  cast: CastMember[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const image = (size: string, path: unknown) => {
  const file = text(path);
  return file?.startsWith("/") ? `${images}/${size}${file}` : undefined;
};

const castLimit = 20;

// Reads TMDB's details with `images` and `credits` (a film) or
// `aggregate_credits` (a series, which names a character per role).
export function parseTmdbArt(answer: unknown): TmdbArt {
  const details = record(answer);
  const logos = list(record(details["images"])["logos"]);
  // English first, then a logo without text language, then any.
  const logo =
    logos.find((l) => l["iso_639_1"] === "en") ??
    logos.find((l) => l["iso_639_1"] == null) ??
    logos[0];
  const credits = record(details["aggregate_credits"] ?? details["credits"]);
  const cast = list(credits["cast"])
    .flatMap((person): CastMember[] => {
      const id = person["id"];
      const name = text(person["name"]);
      if (typeof id !== "number" || !name) return [];
      const character = text(person["character"]) ?? text(list(person["roles"])[0]?.["character"]);
      const photo = image("w185", person["profile_path"]);
      return [{ id, name, ...(character && { character }), ...(photo && { photo }) }];
    })
    .slice(0, castLimit);
  const logoUrl = logo && image("w500", logo["file_path"]);
  const backdrop = image("original", details["backdrop_path"]);
  return { ...(logoUrl && { logo: logoUrl }), ...(backdrop && { backdrop }), cast };
}

const day = 24 * 60 * 60 * 1000;

// An IMDb id's TMDB id, preferring the kind the addon says it is. Kept
// across restarts: the mapping doesn't change.
const tmdbFindQuery = (key: string, imdb: string, media: Media | undefined) =>
  queryOptions({
    queryKey: ["tmdb", "find", imdb, media ?? null],
    queryFn: async ({ signal }) => {
      const answer = record(
        await tmdbGet(key, `/find/${imdb}`, { external_source: "imdb_id" }, signal),
      );
      const first = (kind: Media) => {
        const id = list(answer[`${kind}_results`])[0]?.["id"];
        return typeof id === "number" ? { tmdb: id, media: kind } : undefined;
      };
      return media === "tv"
        ? (first("tv") ?? first("movie") ?? null)
        : (first("movie") ?? first("tv") ?? null);
    },
    staleTime: 7 * day,
    retry: 1,
    meta: { persist: true },
  });

const tmdbDetailsQuery = (key: string, tmdb: number, media: Media) =>
  queryOptions({
    queryKey: ["tmdb", media, tmdb],
    queryFn: async ({ signal }) =>
      parseTmdbArt(
        await tmdbGet(
          key,
          `/${media}/${tmdb}`,
          {
            append_to_response: media === "tv" ? "images,aggregate_credits" : "images,credits",
            include_image_language: "en,null",
          },
          signal,
        ),
      ),
    staleTime: day,
    retry: 1,
    meta: { persist: true },
  });

// A title's TMDB id, as plugins ask by it (#56): at once from the ref, or
// looked up from its IMDb id with the user's key. Undefined while that
// lookup runs; null when there's no id to be had (no ref, no key, or TMDB
// doesn't know the title).
export function useTmdbId(
  ref: TmdbRef | undefined,
): { tmdb: number; media: Media } | null | undefined {
  const imdb = ref && "imdb" in ref ? ref : undefined;
  // The keychain is only read when there's an IMDb id to look up.
  const key = useQuery({ ...tmdbKeyQuery, enabled: Boolean(imdb) }).data;
  const found = useQuery({
    ...tmdbFindQuery(key ?? "", imdb?.imdb ?? "", imdb?.media),
    enabled: Boolean(key && imdb),
  });
  if (!ref) return null;
  if ("tmdb" in ref) return ref;
  if (key === undefined) return undefined;
  if (!key) return null;
  if (found.isPending) return undefined;
  return found.data ?? null;
}

// TMDB's art for a title, or undefined: with no key, no mapping, while it
// loads, or when TMDB fails. Pages show the addon's details meanwhile.
export function useTmdbArt(ref: TmdbRef | undefined): TmdbArt | undefined {
  const key = useTmdbKey();
  const imdb = ref && "imdb" in ref ? ref : undefined;
  const found = useQuery({
    ...tmdbFindQuery(key ?? "", imdb?.imdb ?? "", imdb?.media),
    enabled: Boolean(key && imdb),
  });
  const target = ref && "tmdb" in ref ? ref : (found.data ?? undefined);
  const details = useQuery({
    ...tmdbDetailsQuery(key ?? "", target?.tmdb ?? 0, target?.media ?? "movie"),
    enabled: Boolean(key && target),
  });
  // Cached answers stay in the cache after the key goes; don't show them.
  return key && target ? details.data : undefined;
}
