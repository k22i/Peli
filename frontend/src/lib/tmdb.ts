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

export type Media = "movie" | "tv";

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

// A person on TMDB. The id is kept so a name can become a link later.
export type Person = { id: number; name: string };

// A line of the About card: "Directed by", "Composer", "Created by".
export type CrewGroup = { label: string; people: Person[] };

// A title TMDB suggests, or one film of a collection. It carries TMDB ids;
// the IMDb id Sinag's addons need is looked up when one is opened.
export type RelatedTitle = {
  tmdb: number;
  media: Media;
  title: string;
  year?: string;
  poster?: string;
};

export type TmdbCollection = { id: number; name: string };

// What TMDB adds to a title page, and to the ranking: the title's other names.
export type TmdbArt = {
  // The title's own TMDB id.
  id?: number;
  logo?: string;
  backdrop?: string;
  cast: CastMember[];
  crew: CrewGroup[];
  // The age rating in the user's region (else the US): "PG-13", "TV-MA".
  certificate?: string;
  networks: string[];
  studios: string[];
  // TMDB's user score out of ten, one decimal; absent until it has votes.
  score?: string;
  // A YouTube trailer's address, for the system browser.
  trailer?: string;
  // "More Like This": TMDB's recommendations, else its similar titles.
  related: RelatedTitle[];
  // The collection a film belongs to.
  collection?: TmdbCollection;
  // The title's original name, alternative titles and translated titles, once
  // each, for matching release names (#99). Absent when TMDB lists none.
  aliases?: string[];
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
const crewLimit = 5;
const relatedLimit = 20;
const companyLimit = 3;
const aliasLimit = 300;

// Every other name TMDB gives a title (#99): `original_title` / `original_name`,
// `alternative_titles` (`titles` for a film, `results` for a series) and
// `translations` (a film's `data.title`, a series' `data.name`). Each is listed
// once, without the title's own name, in the order TMDB sends them.
export function parseTmdbAliases(answer: unknown): string[] {
  const details = record(answer);
  const alternatives = record(details["alternative_titles"]);
  const own = text(details["title"] ?? details["name"])?.toLowerCase();
  const names = [
    text(details["original_title"]),
    text(details["original_name"]),
    ...list(alternatives["titles"] ?? alternatives["results"]).map((alt) => text(alt["title"])),
    ...list(record(details["translations"])["translations"]).map((translation) => {
      const data = record(translation["data"]);
      return text(data["title"]) ?? text(data["name"]);
    }),
  ];
  const seen = new Set<string>(own ? [own] : []);
  const out: string[] = [];
  for (const name of names) {
    const title = name?.trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    out.push(title);
    if (out.length === aliasLimit) break;
  }
  return out;
}

const people = (value: unknown): Person[] => {
  const seen = new Set<number>();
  return list(value).flatMap((person): Person[] => {
    const id = person["id"];
    const name = text(person["name"]);
    if (typeof id !== "number" || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name }];
  });
};

const writerJobs = new Set(["Screenplay", "Writer", "Story"]);
const composerJobs = new Set(["Original Music Composer", "Composer"]);

// The crew lines worth showing. A film's `credits.crew` names one `job` per
// entry; a series' `aggregate_credits.crew` lists `jobs` per person, so both
// are flattened to job names first.
function parseCrew(details: Record<string, unknown>): CrewGroup[] {
  const crew = list(record(details["aggregate_credits"] ?? details["credits"])["crew"]);
  const withJob = (jobs: Set<string> | string) =>
    people(
      crew.filter((person) => {
        const names = [text(person["job"]), ...list(person["jobs"]).map((j) => text(j["job"]))];
        return names.some(
          (job) => job !== undefined && (typeof jobs === "string" ? job === jobs : jobs.has(job)),
        );
      }),
    ).slice(0, crewLimit);
  const groups: CrewGroup[] = [
    { label: "Created by", people: people(details["created_by"]).slice(0, crewLimit) },
    { label: "Directed by", people: withJob("Director") },
    { label: "Written by", people: withJob(writerJobs) },
    { label: "Music by", people: withJob(composerJobs) },
  ];
  return groups.filter((group) => group.people.length > 0);
}

// The age rating for `region`, else the US, else none. A film's
// `release_dates` list several releases per country, theatrical (type 3)
// first; a series' `content_ratings` hold one rating per country.
function parseCertificate(details: Record<string, unknown>, region: string): string | undefined {
  const film = list(record(details["release_dates"])["results"]);
  const show = list(record(details["content_ratings"])["results"]);
  for (const country of [region, "US"]) {
    const found = (film.length > 0 ? film : show).find((c) => c["iso_3166_1"] === country);
    if (!found) continue;
    const certificate =
      text(found["rating"]) ??
      list(found["release_dates"])
        .toSorted((a, b) => (a["type"] === 3 ? -1 : 0) - (b["type"] === 3 ? -1 : 0))
        .map((release) => text(release["certification"]))
        .find(Boolean);
    if (certificate) return certificate;
  }
  return undefined;
}

// An official English YouTube trailer, else any English one, else any
// YouTube trailer.
function parseTrailer(details: Record<string, unknown>): string | undefined {
  const rank = (video: Record<string, unknown>) =>
    (video["official"] === true ? 2 : 0) + (video["iso_639_1"] === "en" ? 1 : 0);
  const trailers = list(record(details["videos"])["results"]).filter(
    (video) => video["site"] === "YouTube" && video["type"] === "Trailer" && text(video["key"]),
  );
  const best = trailers.reduce<Record<string, unknown> | undefined>(
    (top, video) => (!top || rank(video) > rank(top) ? video : top),
    undefined,
  );
  const key = text(best?.["key"]);
  return key && /^[\w-]+$/.test(key) ? `https://www.youtube.com/watch?v=${key}` : undefined;
}

const yearOf = (date: unknown) => /^\d{4}/.exec(text(date) ?? "")?.[0];

function parseRelated(items: unknown, fallback: Media): RelatedTitle[] {
  return list(items)
    .flatMap((item): RelatedTitle[] => {
      const id = item["id"];
      const title = text(item["title"]) ?? text(item["name"]);
      const media = item["media_type"] ?? fallback;
      if (typeof id !== "number" || !title || (media !== "movie" && media !== "tv")) return [];
      const year = yearOf(item["release_date"] ?? item["first_air_date"]);
      const poster = image("w342", item["poster_path"]);
      return [{ tmdb: id, media, title, ...(year && { year }), ...(poster && { poster }) }];
    })
    .slice(0, relatedLimit);
}

const names = (value: unknown) =>
  list(value)
    .map((item) => text(item["name"]))
    .filter((name): name is string => name !== undefined)
    .slice(0, companyLimit);

// The region the user's system names ("en-GB" gives "GB"), for age ratings.
const systemRegion = () => /-([A-Za-z]{2})\b/.exec(navigator.language)?.[1]?.toUpperCase() ?? "US";

// Reads TMDB's details with `images` and `credits` (a film) or
// `aggregate_credits` (a series, which names a character per role), the
// title's other names from `alternative_titles` and `translations`, and the
// rest of the page: age rating, trailer, suggestions and collection.
export function parseTmdbArt(answer: unknown, region = systemRegion()): TmdbArt {
  const details = record(answer);
  const media: Media = "first_air_date" in details || "created_by" in details ? "tv" : "movie";
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
  const aliases = parseTmdbAliases(details);
  const certificate = parseCertificate(details, region);
  const trailer = parseTrailer(details);
  const votes = details["vote_count"];
  const average = details["vote_average"];
  const score =
    typeof average === "number" && typeof votes === "number" && votes > 0 && average > 0
      ? average.toFixed(1)
      : undefined;
  const suggested = parseRelated(record(details["recommendations"])["results"], media);
  const related =
    suggested.length > 0 ? suggested : parseRelated(record(details["similar"])["results"], media);
  const owned = record(details["belongs_to_collection"]);
  const collectionName = text(owned["name"]);
  const collection =
    typeof owned["id"] === "number" && collectionName
      ? { id: owned["id"], name: collectionName }
      : undefined;
  const id = details["id"];
  return {
    ...(typeof id === "number" && { id }),
    ...(logoUrl && { logo: logoUrl }),
    ...(backdrop && { backdrop }),
    cast,
    crew: parseCrew(details),
    ...(certificate && { certificate }),
    networks: names(details["networks"]),
    studios: names(details["production_companies"]),
    ...(score && { score }),
    ...(trailer && { trailer }),
    related,
    ...(collection && { collection }),
    ...(aliases.length > 0 && { aliases }),
  };
}

// The films of a collection, oldest first; undated ones last.
export function parseTmdbCollection(answer: unknown): RelatedTitle[] {
  const parts = list(record(answer)["parts"]);
  const dated = parts.map((part) => ({
    part,
    date: text(part["release_date"]) ?? "9999",
  }));
  const order = new Map(dated.map(({ part, date }) => [part["id"], date]));
  return parseRelated(parts, "movie").toSorted((a, b) =>
    String(order.get(a.tmdb)).localeCompare(String(order.get(b.tmdb))),
  );
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
    // "page": the answer carries crew, rating, trailer and suggestions on
    // top of the title's other names; older persisted answers under
    // ["tmdb", media, id] and [..., "aliases"] lack them, and age out.
    queryKey: ["tmdb", media, tmdb, "page"],
    queryFn: async ({ signal }) =>
      parseTmdbArt(
        await tmdbGet(
          key,
          `/${media}/${tmdb}`,
          {
            append_to_response:
              media === "tv"
                ? "images,aggregate_credits,alternative_titles,translations,content_ratings,videos,recommendations,similar"
                : "images,credits,alternative_titles,translations,release_dates,videos,recommendations,similar",
            include_image_language: "en,null",
            include_video_language: "en,null",
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

const none: string[] = [];

// The title's other names from TMDB, for the ranking's title check (#99): the
// same request as the title page's art, so it is asked once. Empty with no
// key, no mapping, while it loads, or when TMDB fails or doesn't know the
// title: ranking then has only the addon's name.
export function useTmdbAliases(ref: TmdbRef | undefined): string[] {
  return useTmdbArt(ref)?.aliases ?? none;
}

// A collection's films. Asked only for a film that belongs to one.
const tmdbCollectionQuery = (key: string, id: number) =>
  queryOptions({
    queryKey: ["tmdb", "collection", id],
    queryFn: async ({ signal }) =>
      parseTmdbCollection(await tmdbGet(key, `/collection/${id}`, {}, signal)),
    staleTime: day,
    retry: 1,
    meta: { persist: true },
  });

// The films of the collection, or undefined with no key, while it loads or
// when TMDB fails.
export function useTmdbCollection(collection: TmdbCollection | undefined) {
  const key = useTmdbKey();
  const found = useQuery({
    ...tmdbCollectionQuery(key ?? "", collection?.id ?? 0),
    enabled: Boolean(key && collection),
  });
  return key && collection ? found.data : undefined;
}

// A TMDB title's IMDb id, which Sinag's addons answer by. TMDB ids aren't
// understood by Cinemeta, so a suggested title is looked up when opened.
export const tmdbImdbQuery = (key: string, media: Media, tmdb: number) =>
  queryOptions({
    queryKey: ["tmdb", "imdb", media, tmdb],
    queryFn: async ({ signal }) => {
      const id = record(await tmdbGet(key, `/${media}/${tmdb}/external_ids`, {}, signal))[
        "imdb_id"
      ];
      return typeof id === "string" && /^tt\d+$/.test(id) ? id : null;
    },
    staleTime: 30 * day,
    retry: 1,
    meta: { persist: true },
  });
