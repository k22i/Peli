import { describe, expect, it } from "vite-plus/test";

import { parseTmdbPerson, sortCredits } from "./tmdb-person";

const answer = {
  id: 1,
  name: "Greta Gerwig",
  known_for_department: "Directing",
  biography: "  ",
  deathday: "",
  combined_credits: {
    cast: [
      { id: 10, media_type: "movie", title: "Frances Ha", character: "Frances", popularity: 3 },
      // The same series twice: one entry.
      { id: 20, media_type: "tv", name: "Show", character: "Self", popularity: 1 },
      { id: 20, media_type: "tv", name: "Show", character: "Self", popularity: 1 },
    ],
    crew: [
      { id: 30, media_type: "movie", title: "Barbie", job: "Director", department: "Directing" },
      { id: 30, media_type: "movie", title: "Barbie", job: "Director", department: "Directing" },
      { id: 31, media_type: "movie", title: "Lady Bird", job: "Writer", department: "Writing" },
      { id: 31, media_type: "movie", title: "Lady Bird", job: "Screenplay", department: "Writing" },
    ],
  },
};

describe("parseTmdbPerson", () => {
  it("groups credits by kind of work, the known-for department first", () => {
    const person = parseTmdbPerson(answer)!;
    expect(person.groups.map((group) => group.label)).toEqual(["Directing", "Acting", "Writing"]);
    expect(person.groups[1]!.credits).toHaveLength(2);
    expect(person.groups[2]!.credits[0]!.role).toBe("Writer, Screenplay");
    expect(person.biography).toBeUndefined();
    expect(person.died).toBeUndefined();
  });

  it("has nothing for an answer without an id and name", () => {
    expect(parseTmdbPerson({ success: false })).toBeUndefined();
    expect(parseTmdbPerson(null)).toBeUndefined();
  });
});

describe("sortCredits", () => {
  const credits = [
    { tmdb: 1, media: "movie" as const, title: "A", popularity: 5, date: "2001-01-01" },
    { tmdb: 2, media: "movie" as const, title: "B", popularity: 9, date: "1990-01-01" },
    { tmdb: 3, media: "tv" as const, title: "C", popularity: 1 },
  ];

  it("puts the popular first, or the newest first with undated ones on top", () => {
    expect(sortCredits(credits, "popular").map((c) => c.title)).toEqual(["B", "A", "C"]);
    expect(sortCredits(credits, "newest").map((c) => c.title)).toEqual(["C", "A", "B"]);
  });
});
