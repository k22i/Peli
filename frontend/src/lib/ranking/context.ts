import type { ContentType, Meta } from "@/lib/addon-protocol";

// What the ranking engine knows about the asked-for video before any stream
// arrives (#51): from the title's details, and from the id itself.
export type TitleContext = {
  type: "movie" | "series";
  // Anime's releases count episodes their own way and often say "Dual Audio".
  anime: boolean;
  // The id streams were asked for: "tt0903747:1:1", "kitsu:46474:1", "tt0111161".
  id: string;
  name: string;
  // Other titles the release names may use.
  aliases?: string[];
  year?: number;
  // A film's, or one episode's.
  runtimeMin?: number;
  season?: number;
  episode?: number;
  // A Kitsu episode's numbers by season, for long runners (#100).
  map?: EpisodeMap;
};

// One Kitsu episode in the other numbering systems (ADR-0050): the season and
// episode the releases may call it ("S22E15"), and its absolute number
// ("1100"). The Kitsu addon sends them on each video as `imdbSeason`,
// `imdbEpisode` and `absoluteEpisode`.
export type EpisodeMap = { season: number; episode: number; absolute: number };

// The map of `video` ("kitsu:12:1100") from a title's details, when the
// addon that answered sends one (the AniList addon doesn't).
export function episodeMapOf(meta: Meta | undefined, video: string): EpisodeMap | undefined {
  const found = meta?.videos?.find((v) => v.id === video);
  const season = found?.["imdbSeason"];
  const episode = found?.["imdbEpisode"];
  const absolute = found?.["absoluteEpisode"];
  return typeof season === "number" && typeof episode === "number" && typeof absolute === "number"
    ? { season, episode, absolute }
    : undefined;
}

// "142 min", "2h 22min", "2h".
export function runtimeMinutes(runtime: string | undefined): number | undefined {
  const m = runtime?.match(/^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);
  const minutes = Number(m?.[1] ?? 0) * 60 + Number(m?.[2] ?? 0);
  return minutes > 0 ? minutes : undefined;
}

// "tt0903747:1:2" → season 1, episode 2; "kitsu:46474:3" → episode 3 (Kitsu
// ids are per season, or absolute for long runners).
export function videoNumbers(id: string): { season?: number; episode?: number } {
  const parts = id.split(":");
  if (parts[0] === "kitsu") {
    const episode = Number(parts[2]);
    return Number.isInteger(episode) ? { episode } : {};
  }
  const season = Number(parts.at(-2));
  const episode = Number(parts.at(-1));
  return parts.length >= 3 && Number.isInteger(season) && Number.isInteger(episode)
    ? { season, episode }
    : {};
}

const yearOf = (meta: Meta | undefined) =>
  Number((meta?.releaseInfo ?? meta?.released)?.match(/\b(19|20)\d\d\b/)?.[0]) || undefined;

// The context for streams of `video` (the film's id, or an episode's), from
// the title's details when they're known. Without them, the name is the
// fallback heading and the checks that need a year or runtime don't run.
export function titleContext(
  type: ContentType,
  video: string,
  meta: Meta | undefined,
  fallbackName: string,
  map?: EpisodeMap,
): TitleContext {
  const aliases = meta?.["aliases"];
  const year = yearOf(meta);
  const runtimeMin = runtimeMinutes(meta?.runtime);
  return {
    type: type === "movie" ? "movie" : "series",
    anime:
      video.startsWith("kitsu:") ||
      type === "anime" ||
      (meta?.genres ?? []).some((genre) => /^anime$/i.test(genre)),
    id: video,
    name: meta?.name ?? fallbackName,
    ...(Array.isArray(aliases) && {
      aliases: aliases.filter((alias): alias is string => typeof alias === "string"),
    }),
    ...(year && { year }),
    ...(runtimeMin && { runtimeMin }),
    ...videoNumbers(video),
    ...(map && { map }),
  };
}
