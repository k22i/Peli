import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { parseMetaResponse } from "@/lib/addon-protocol/parse";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import kitsuAnime from "@/lib/addon-protocol/fixtures/kitsu/meta-anime.json";

import {
  checkTmdbKey,
  parseTmdbAliases,
  parseTmdbArt,
  parseTmdbCollection,
  tmdbKeyProblem,
  tmdbRef,
} from "./tmdb";

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
      crew: [],
      networks: [],
      studios: [],
      related: [],
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
    const empty = { cast: [], crew: [], networks: [], studios: [], related: [] };
    expect(parseTmdbArt(null)).toEqual(empty);
    expect(parseTmdbArt({ images: "no", credits: { cast: "no" } })).toEqual(empty);
  });
});

const poster = (path: string) => `https://image.tmdb.org/t/p/w342${path}`;

describe("parseTmdbArt: the rest of the page", () => {
  const film = {
    id: 155,
    vote_average: 8.52,
    vote_count: 30000,
    credits: {
      crew: [
        { id: 525, name: "Christopher Nolan", job: "Director" },
        { id: 525, name: "Christopher Nolan", job: "Screenplay" },
        { id: 527, name: "Jonathan Nolan", job: "Screenplay" },
        { id: 530, name: "David S. Goyer", job: "Story" },
        { id: 947, name: "Hans Zimmer", job: "Original Music Composer" },
        { id: 1, name: "Someone", job: "Gaffer" },
      ],
    },
    release_dates: {
      results: [
        { iso_3166_1: "DE", release_dates: [{ certification: "12", type: 3 }] },
        {
          iso_3166_1: "US",
          release_dates: [
            { certification: "", type: 1 },
            { certification: "R", type: 5 },
            { certification: "PG-13", type: 3 },
          ],
        },
      ],
    },
    production_companies: [{ name: "Legendary" }, { name: "Syncopy" }],
    belongs_to_collection: { id: 263, name: "The Dark Knight Collection" },
    videos: {
      results: [
        { site: "Vimeo", type: "Trailer", key: "vimeo", official: true, iso_639_1: "en" },
        { site: "YouTube", type: "Teaser", key: "teaser", official: true, iso_639_1: "en" },
        { site: "YouTube", type: "Trailer", key: "fan", official: false, iso_639_1: "en" },
        { site: "YouTube", type: "Trailer", key: "de", official: true, iso_639_1: "de" },
        { site: "YouTube", type: "Trailer", key: "EXeTwQWrcwY", official: true, iso_639_1: "en" },
      ],
    },
    recommendations: {
      results: [
        { id: 272, title: "Batman Begins", release_date: "2005-06-10", poster_path: "/bb.jpg" },
        { id: 0, poster_path: null },
      ],
    },
    similar: { results: [{ id: 1, title: "Other" }] },
  };

  it("lists a film's director, writers and composer once each", () => {
    expect(parseTmdbArt(film).crew).toEqual([
      { label: "Directed by", people: [{ id: 525, name: "Christopher Nolan" }] },
      {
        label: "Written by",
        people: [
          { id: 525, name: "Christopher Nolan" },
          { id: 527, name: "Jonathan Nolan" },
          { id: 530, name: "David S. Goyer" },
        ],
      },
      { label: "Music by", people: [{ id: 947, name: "Hans Zimmer" }] },
    ]);
  });

  it("names a series' creators and composer from its aggregate credits", () => {
    const art = parseTmdbArt({
      first_air_date: "2008-01-20",
      created_by: [{ id: 66633, name: "Vince Gilligan" }],
      aggregate_credits: {
        crew: [{ id: 7, name: "Dave Porter", jobs: [{ job: "Original Music Composer" }] }],
      },
    });
    expect(art.crew).toEqual([
      { label: "Created by", people: [{ id: 66633, name: "Vince Gilligan" }] },
      { label: "Music by", people: [{ id: 7, name: "Dave Porter" }] },
    ]);
  });

  it("takes the theatrical certificate for the region, else the US", () => {
    expect(parseTmdbArt(film, "DE").certificate).toBe("12");
    expect(parseTmdbArt(film, "US").certificate).toBe("PG-13");
    expect(parseTmdbArt(film, "FR").certificate).toBe("PG-13");
    expect(parseTmdbArt({ id: 1 }).certificate).toBeUndefined();
  });

  it("reads a series' content rating", () => {
    const show = {
      first_air_date: "2008-01-20",
      content_ratings: {
        results: [
          { iso_3166_1: "GB", rating: "18" },
          { iso_3166_1: "US", rating: "TV-MA" },
        ],
      },
      networks: [{ name: "AMC" }],
    };
    expect(parseTmdbArt(show, "GB").certificate).toBe("18");
    expect(parseTmdbArt(show, "AU").certificate).toBe("TV-MA");
    expect(parseTmdbArt(show).networks).toEqual(["AMC"]);
  });

  it("gives studios and the score, which needs votes", () => {
    expect(parseTmdbArt(film).studios).toEqual(["Legendary", "Syncopy"]);
    expect(parseTmdbArt(film).score).toBe("8.5");
    expect(parseTmdbArt({ vote_average: 0, vote_count: 0 }).score).toBeUndefined();
  });

  it("picks the official English YouTube trailer", () => {
    expect(parseTmdbArt(film).trailer).toBe("https://www.youtube.com/watch?v=EXeTwQWrcwY");
    expect(
      parseTmdbArt({ videos: { results: [{ site: "YouTube", type: "Teaser", key: "t" }] } })
        .trailer,
    ).toBeUndefined();
    expect(
      parseTmdbArt({
        videos: { results: [{ site: "YouTube", type: "Trailer", key: "a b&c" }] },
      }).trailer,
    ).toBeUndefined();
  });

  it("lists recommendations, falling back to similar titles", () => {
    expect(parseTmdbArt(film).related).toEqual([
      {
        tmdb: 272,
        media: "movie",
        title: "Batman Begins",
        year: "2005",
        poster: poster("/bb.jpg"),
      },
    ]);
    const { recommendations: ignored, ...similarOnly } = film;
    expect(ignored.results).toHaveLength(2);
    expect(parseTmdbArt(similarOnly).related).toEqual([
      { tmdb: 1, media: "movie", title: "Other" },
    ]);
    const many = Array.from({ length: 30 }, (_unused, id) => ({ id: id + 1, name: `S${id}` }));
    const art = parseTmdbArt({ first_air_date: "2020", recommendations: { results: many } });
    expect(art.related).toHaveLength(20);
    expect(art.related[0]?.media).toBe("tv");
  });

  it("keeps the film's own id and collection", () => {
    const art = parseTmdbArt(film);
    expect(art.id).toBe(155);
    expect(art.collection).toEqual({ id: 263, name: "The Dark Knight Collection" });
  });
});

describe("parseTmdbCollection", () => {
  it("lists the films in release order, undated ones last", () => {
    expect(
      parseTmdbCollection({
        parts: [
          { id: 3, title: "Rises", release_date: "2012-07-16", poster_path: "/r.jpg" },
          { id: 9, title: "Next" },
          { id: 1, title: "Begins", release_date: "2005-06-10" },
          { id: 2, title: "Knight", release_date: "2008-07-16" },
        ],
      }).map((film) => film.title),
    ).toEqual(["Begins", "Knight", "Rises", "Next"]);
    expect(parseTmdbCollection(null)).toEqual([]);
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
    expect(parseTmdbArt({ title: "Up", original_title: "Up" })).not.toHaveProperty("aliases");
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
