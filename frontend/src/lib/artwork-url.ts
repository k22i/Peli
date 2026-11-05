// Sharper artwork (#113). Cards are twice as big as they were, so the small
// image an addon names is upscaled to a blur on a 2× display (a 20rem poster
// is 640 device px; Metahub's `small` is 300). `sharper` rewrites the URL of
// the two image hosts that serve several sizes to a larger one; any other URL
// passes through unchanged, and so does a URL that is already big enough.
//
// `Artwork` calls it (one place for every card, still, cover and hero), and
// it falls back to the original URL once if the rewritten one fails to load.
//
// Measured against Metahub on 2026-11-05 (tt0111161 / tt0903747):
//   poster      small 300×450 36–42 kB · medium 500×750 49–60 kB · large 780×1170 205–223 kB
//   background  small 480×270 22–26 kB · medium = large = 1920×1080 560–783 kB
//   logo        small = medium = large, 65–89 kB
// So `large` posters cost about 5× the bytes of `small` and are what a 2×
// card needs; `medium` backdrops are already full HD and `large` is the same
// file today, which is why the Home hero keeps asking for `medium` (a heavy
// `large` can't sneak in if Metahub ever makes it a different file).

export type ArtworkUse = "poster" | "landscape" | "backdrop" | "logo" | "avatar";

const metahub =
  /^(https:\/\/(?:images|live)\.metahub\.space\/)(poster|background|logo)\/(small|medium)\//;
const tmdb = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(w\d+|original)\//;

// What each use asks of TMDB: posters and stills at w780, cast at w342.
const tmdbWidth: Partial<Record<ArtworkUse, number>> = {
  poster: 780,
  landscape: 780,
  avatar: 342,
};

// Which Metahub kind each use rewrites, and to what.
const metahubKind: Partial<Record<ArtworkUse, string>> = {
  poster: "poster",
  landscape: "background",
  logo: "logo",
};

export function sharper(url: string | undefined, use: ArtworkUse): string | undefined {
  if (!url) return url;

  const hub = metahub.exec(url);
  if (hub) {
    return metahubKind[use] === hub[2] ? url.replace(metahub, "$1$2/large/") : url;
  }

  const movieDb = tmdb.exec(url);
  const width = tmdbWidth[use];
  if (movieDb && width) {
    const size = movieDb[2]!;
    // `original` is already the biggest; never step down from a bigger size.
    if (size === "original" || Number(size.slice(1)) >= width) return url;
    return url.replace(tmdb, `$1w${width}/`);
  }

  return url;
}
