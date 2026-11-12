// Sharper artwork (#113). Cards are 1.5× as big as they were, so the small
// image an addon names is upscaled to a blur on a 2× display (a 15rem poster
// is 480 device px; Metahub's `small` is 300). `sharper` rewrites the URL of
// the two image hosts that serve several sizes to one big enough for that;
// any other URL passes through unchanged, and so does a URL that is already
// big enough.
//
// `Artwork` calls it (one place for every card, still, cover and hero), and
// it falls back to the original URL once if the rewritten one fails to load.
//
// Measured against Metahub on 2026-11-05 (tt0111161 / tt0903747):
//   poster      small 300×450 36–42 kB · medium 500×750 49–60 kB · large 780×1170 205–223 kB
//   background  small 480×270 22–26 kB · medium = large = 1920×1080 560–783 kB
//   logo        small = medium = large, 65–89 kB
// A poster card is 480 device px wide, so `medium` (500) is sharp enough and
// `large` would cost 4× the bytes and 2.4× the decoded bitmap for nothing;
// a landscape card is 864, which `small` (480) can't fill but `medium`
// (1920, already full HD) can. The hero keeps `medium` backdrops.

import { isIOS } from "@/lib/platform";

export type ArtworkUse = "poster" | "landscape" | "backdrop" | "logo" | "avatar";

const metahub =
  /^(https:\/\/(?:images|live)\.metahub\.space\/)(poster|background|logo)\/(small|medium)\//;
const tmdb = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(w\d+|original)\//;

// What each use asks of TMDB: posters at w500 (480 device px), stills at
// w780 (864), cast photos at w342.
const tmdbWidth: Partial<Record<ArtworkUse, number>> = {
  poster: 500,
  landscape: 780,
  avatar: 342,
};

// Which Metahub kind each use rewrites, and to which size.
const metahubTarget: Partial<Record<ArtworkUse, { kind: string; size: string }>> = {
  poster: { kind: "poster", size: "medium" },
  landscape: { kind: "background", size: "medium" },
  logo: { kind: "logo", size: "large" },
};

export function sharper(url: string | undefined, use: ArtworkUse): string | undefined {
  if (!url) return url;

  const hub = metahub.exec(url);
  if (hub) {
    const target = metahubTarget[use];
    // `medium` stays `medium`; a `large` URL doesn't match at all.
    if (!target || target.kind !== hub[2] || target.size === hub[3]) return url;
    return url.replace(metahub, `$1$2/${target.size}/`);
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

// An `http:` image can't load in the iOS webview: App Transport Security
// stops a plain-http subresource to a domain, and ADR-0055 keeps the app's
// network rules strict. On iOS those go through the app's own server, which
// fetches them from Go (imageproxy_ios.go). https and everything off iOS
// load as they are. Never log the result: it holds the original URL.
export const imageProxyPath = "/__image?url=";

export function viaProxy(url: string): string;
export function viaProxy(url: string | undefined): string | undefined;
export function viaProxy(url: string | undefined): string | undefined {
  if (url === undefined || !isIOS() || !url.startsWith("http:")) return url;
  return imageProxyPath + encodeURIComponent(url);
}
