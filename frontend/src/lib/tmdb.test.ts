import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { parseMetaResponse } from "@/lib/addon-protocol/parse";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import kitsuAnime from "@/lib/addon-protocol/fixtures/kitsu/meta-anime.json";

import { checkTmdbKey, parseTmdbAliases, parseTmdbArt, tmdbKeyProblem, tmdbRef } from "./tmdb";

vi.mock("@bindings/secrets", () => ({ Service: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tmdbRef", () => {
  it("takes Cinemeta's moviedb_id first", () => {
    expect(tmdbRef("movie", "tt0111161", parseMetaResponse(cinemetaMovie).meta)).toEqual({
      tmdb: 278,
      media: "movie",
    });
  });

  it("reads tmdb: ids, typed by the addon", () => {
    expect(tmdbRef("series", "tmdb:1396")).toEqual({ tmdb: 1396, media: "tv" });
    expect(tmdbRef("movie", "tmdb:278")).toEqual({ tmdb: 278, media: "movie" });
  });

  it("looks up an IMDb id, or a Kitsu title's imdb_id", () => {
    expect(tmdbRef("series", "tt0903747")).toEqual({ imdb: "tt0903747", media: "tv" });
    expect(tmdbRef("series", "kitsu:46474", parseMetaResponse(kitsuAnime).meta)).toEqual({
      imdb: "tt22248376",
      media: "tv",
    });
    // An addon's own type: TMDB says what it is.
    expect(tmdbRef("anime", "tt22248376")).toEqual({ imdb: "tt22248376", media: undefined });
  });

  it("has nothing for a title without a mapping", () => {
    expect(tmdbRef("series", "kitsu:46474")).toBeUndefined();
    expect(tmdbRef("series", "kitsu:46474", { id: "kitsu:46474", type: "series", name: "x" })).toBe(
      undefined,
    );
    expect(tmdbRef("channel", "yt:abc")).toBeUndefined();
  });
});

describe("parseTmdbArt", () => {
  it("picks the English logo, the main backdrop and the cast with photos", () => {
    const art = parseTmdbArt({
      backdrop_path: "/back.jpg",
      images: {
        logos: [
          { iso_639_1: "de", file_path: "/de.png" },
          { iso_639_1: "en", file_path: "/en.png" },
        ],
      },
      credits: {
        cast: [
          { id: 1, name: "Tim Robbins", character: "Andy Dufresne", profile_path: "/tim.jpg" },
          { id: 2, name: "Nobody", profile_path: null },
          { name: "No id" },
        ],
      },
    });
    expect(art).toEqual({
      logo: "https://image.tmdb.org/t/p/w500/en.png",
      backdrop: "https://image.tmdb.org/t/p/original/back.jpg",
      cast: [
        {
          id: 1,
          name: "Tim Robbins",
          character: "Andy Dufresne",
          photo: "https://image.tmdb.org/t/p/w185/tim.jpg",
        },
        { id: 2, name: "Nobody" },
      ],
    });
  });

  it("names a series' characters from its aggregate credits", () => {
    const art = parseTmdbArt({
      images: { logos: [{ iso_639_1: null, file_path: "/plain.svg" }] },
      aggregate_credits: {
        cast: [{ id: 17419, name: "Bryan Cranston", roles: [{ character: "Walter White" }] }],
      },
    });
    expect(art.logo).toBe("https://image.tmdb.org/t/p/w500/plain.svg");
    expect(art.backdrop).toBeUndefined();
    expect(art.cast).toEqual([{ id: 17419, name: "Bryan Cranston", character: "Walter White" }]);
  });

  it("keeps twenty people and survives an odd answer", () => {
    const cast = Array.from({ length: 30 }, (_, id) => ({ id, name: `P${id}` }));
    expect(parseTmdbArt({ credits: { cast } }).cast).toHaveLength(20);
    expect(parseTmdbArt(null)).toEqual({ cast: [] });
    expect(parseTmdbArt({ images: "no", credits: { cast: "no" } })).toEqual({ cast: [] });
  });
});

// Answers every request with status.
function answer(status: number) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response("{}", { status })),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("parseTmdbAliases", () => {
  it("lists a film's original, alternative and translated titles once each", () => {
    const aliases = parseTmdbAliases({
      title: "The Shawshank Redemption",
      original_title: "The Shawshank Redemption",
      alternative_titles: {
        titles: [
          { iso_3166_1: "ES", title: "Cadena perpetua", type: "" },
          { iso_3166_1: "FR", title: "Les Évadés", type: "" },
          { iso_3166_1: "MX", title: "cadena perpetua", type: "" },
        ],
      },
      translations: {
        translations: [
          { iso_639_1: "de", data: { title: "Die Verurteilten" } },
          { iso_639_1: "en", data: { title: "The Shawshank Redemption" } },
          { iso_639_1: "ru", data: { title: "Побег из Шоушенка" } },
          { iso_639_1: "xx", data: { title: "" } },
        ],
      },
    });
    expect(aliases).toEqual([
      "Cadena perpetua",
      "Les Évadés",
      "Die Verurteilten",
      "Побег из Шоушенка",
    ]);
  });

  it("reads a series' results and translated names", () => {
    expect(
      parseTmdbAliases({
        name: "Money Heist",
        original_name: "La casa de papel",
        alternative_titles: { results: [{ iso_3166_1: "DE", title: "Haus des Geldes" }] },
        translations: { translations: [{ iso_639_1: "ru", data: { name: "Бумажный дом" } }] },
      }),
    ).toEqual(["La casa de papel", "Haus des Geldes", "Бумажный дом"]);
  });

  it("keeps the original title of a film named differently", () => {
    expect(parseTmdbAliases({ title: "Your Name.", original_title: "君の名は。" })).toEqual([
      "君の名は。",
    ]);
  });

  it("has none for an answer without them, or an odd one", () => {
    expect(parseTmdbAliases({ title: "Up" })).toEqual([]);
    expect(parseTmdbAliases(null)).toEqual([]);
    expect(
      parseTmdbAliases({ alternative_titles: "no", translations: { translations: 3 } }),
    ).toEqual([]);
  });

  it("is part of the details art, when there are any", () => {
    expect(parseTmdbArt({ title: "Up", original_title: "Up" })).toEqual({ cast: [] });
    expect(parseTmdbArt({ title: "Up", original_title: "Oben" }).aliases).toEqual(["Oben"]);
  });
});

describe("checkTmdbKey", () => {
  it("sends a v3 key as api_key and a v4 token as a bearer token", async () => {
    const fetch = answer(200);
    await checkTmdbKey("0123456789abcdef0123456789abcdef");
    await checkTmdbKey("eyJhbGciOiJIUzI1NiJ9.e30.sig");
    const [v3, v3Init] = fetch.mock.calls[0]!;
    const [v4, v4Init] = fetch.mock.calls[1]!;
    expect(v3).toBe(
      "https://api.themoviedb.org/3/authentication?api_key=0123456789abcdef0123456789abcdef",
    );
    expect(v3Init.headers).not.toHaveProperty("Authorization");
    expect(v4).toBe("https://api.themoviedb.org/3/authentication");
    expect(v4Init.headers).toHaveProperty("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig");
  });

  it("says why a key isn't taken", async () => {
    answer(401);
    await expect(checkTmdbKey("wrong")).rejects.toMatchObject({ kind: "key_refused" });
    answer(503);
    await expect(checkTmdbKey("key")).rejects.toMatchObject({ kind: "unavailable" });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Load failed")));
    await expect(checkTmdbKey("key")).rejects.toMatchObject({ kind: "unreachable" });
    await expect(checkTmdbKey("two words")).rejects.toMatchObject({ kind: "invalid_key" });
  });

  it("finds keys that can't be right before asking", () => {
    expect(tmdbKeyProblem("")).toBe("Enter a key.");
    expect(tmdbKeyProblem("a b")).toMatch(/no spaces/);
    expect(tmdbKeyProblem("0123456789abcdef0123456789abcdef")).toBeUndefined();
  });
});
