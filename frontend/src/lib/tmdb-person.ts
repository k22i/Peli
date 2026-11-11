import { queryOptions, useQuery } from "@tanstack/react-query";

import { parseRelated, tmdbGet, tmdbKeyQuery, tmdbImage, type RelatedTitle } from "@/lib/tmdb";

// A person's page from TMDB: who they are and what they've worked on. One
// request (`combined_credits` carries films and series together), so it is
// asked once per person and kept for a day.

// A film or series they worked on. `role` is the character or the job.
export type Credit = RelatedTitle & {
  popularity: number;
  // "1994-09-23", for sorting; absent for something unreleased and undated.
  date?: string;
  role?: string;
};

export type CreditGroup = { label: string; credits: Credit[] };

export type TmdbPerson = {
  id: number;
  name: string;
  department?: string;
  biography?: string;
  born?: string;
  died?: string;
  birthplace?: string;
  photo?: string;
  groups: CreditGroup[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const list = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

// Acting first, then the crafts people are most often known for; the rest
// (Camera, Art, Crew…) follow in the order TMDB lists them.
const groupOrder = ["Acting", "Directing", "Writing", "Production", "Sound"];

// One entry per title and role group: TMDB lists a series once per episode
// credit or appearance, and a person can hold several jobs on one film.
function toCredit(item: Record<string, unknown>, role: string | undefined): Credit | undefined {
  const [title] = parseRelated([item], item["media_type"] === "tv" ? "tv" : "movie");
  if (!title) return undefined;
  const popularity = typeof item["popularity"] === "number" ? item["popularity"] : 0;
  const date = text(item["release_date"]) ?? text(item["first_air_date"]);
  return { ...title, popularity, ...(date && { date }), ...(role && { role }) };
}

export function parseTmdbPerson(answer: unknown, known?: string): TmdbPerson | undefined {
  const details = record(answer);
  const id = details["id"];
  const name = text(details["name"]);
  if (typeof id !== "number" || !name) return undefined;
  const credits = record(details["combined_credits"]);
  const byGroup = new Map<string, Map<string, Credit>>();
  const add = (group: string, credit: Credit | undefined) => {
    if (!credit) return;
    const titles = byGroup.get(group) ?? new Map<string, Credit>();
    const key = `${credit.media}:${credit.tmdb}`;
    const existing = titles.get(key);
    // A second job on the same title joins the first: "Director, Writer".
    if (existing) {
      if (credit.role && existing.role && !existing.role.includes(credit.role)) {
        existing.role = `${existing.role}, ${credit.role}`;
      }
    } else {
      titles.set(key, credit);
    }
    byGroup.set(group, titles);
  };
  for (const item of list(credits["cast"])) {
    add("Acting", toCredit(item, text(item["character"])));
  }
  for (const item of list(credits["crew"])) {
    add(text(item["department"]) ?? "Crew", toCredit(item, text(item["job"])));
  }
  const department = text(details["known_for_department"]) ?? known;
  const rank = (label: string) => {
    if (label === department) return -1;
    const index = groupOrder.indexOf(label);
    return index === -1 ? groupOrder.length : index;
  };
  const groups = [...byGroup]
    .map(([label, titles]) => ({ label, credits: [...titles.values()] }))
    .toSorted((a, b) => rank(a.label) - rank(b.label));
  const photo = tmdbImage("w500", details["profile_path"]);
  return {
    id,
    name,
    ...(department && { department }),
    ...(text(details["biography"]) && { biography: text(details["biography"])! }),
    ...(text(details["birthday"]) && { born: text(details["birthday"])! }),
    ...(text(details["deathday"]) && { died: text(details["deathday"])! }),
    ...(text(details["place_of_birth"]) && { birthplace: text(details["place_of_birth"])! }),
    ...(photo && { photo }),
    groups,
  };
}

export type CreditSort = "popular" | "newest";

// Most popular first, or newest first with undated (announced) titles on top.
export function sortCredits(credits: readonly Credit[], sort: CreditSort): Credit[] {
  return credits.toSorted((a, b) =>
    sort === "popular"
      ? b.popularity - a.popularity
      : (b.date ?? "9999").localeCompare(a.date ?? "9999") || b.popularity - a.popularity,
  );
}

const day = 24 * 60 * 60 * 1000;

const tmdbPersonQuery = (key: string, id: number) =>
  queryOptions({
    queryKey: ["tmdb", "person", id],
    queryFn: async ({ signal }) =>
      parseTmdbPerson(
        await tmdbGet(
          key,
          `/person/${id}`,
          { append_to_response: "combined_credits,external_ids,images" },
          signal,
        ),
      ) ?? null,
    staleTime: day,
    retry: 1,
    meta: { persist: true },
  });

// The person's page, or why there isn't one: `key: false` with no TMDB key
// (the page says how to add one), `data: null` when TMDB doesn't know the id.
export function useTmdbPerson(id: number) {
  const key = useQuery(tmdbKeyQuery).data;
  const person = useQuery({ ...tmdbPersonQuery(key ?? "", id), enabled: Boolean(key) });
  return {
    key: key === undefined ? undefined : Boolean(key),
    person: key ? person.data : undefined,
    isError: person.isError,
    refetch: () => void person.refetch(),
  };
}

// A person in search results: their photo, and what they are known for.
export type PersonHit = {
  id: number;
  name: string;
  department?: string;
  photo?: string;
  // Up to three titles, for the card's line.
  knownFor: string[];
};

const peopleLimit = 20;

export function parseTmdbPeople(answer: unknown): PersonHit[] {
  return list(record(answer)["results"])
    .flatMap((person): PersonHit[] => {
      const id = person["id"];
      const name = text(person["name"]);
      if (typeof id !== "number" || !name) return [];
      const department = text(person["known_for_department"]);
      const photo = tmdbImage("w342", person["profile_path"]);
      const knownFor = list(person["known_for"])
        .map((item) => text(item["title"]) ?? text(item["name"]))
        .filter((title): title is string => title !== undefined)
        .slice(0, 3);
      return [{ id, name, ...(department && { department }), ...(photo && { photo }), knownFor }];
    })
    .slice(0, peopleLimit);
}

// People matching a search, for Search's People row. Kept in memory only:
// searches are one-offs.
const tmdbPeopleQuery = (key: string, term: string) =>
  queryOptions({
    queryKey: ["tmdb", "search-person", term],
    queryFn: async ({ signal }) =>
      parseTmdbPeople(await tmdbGet(key, "/search/person", { query: term }, signal)),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

// The people TMDB finds for `term`: undefined with no key, no term or while
// it loads, and when TMDB fails (the row just doesn't show).
export function useTmdbPeople(term: string | undefined, enabled: boolean): PersonHit[] | undefined {
  const key = useQuery(tmdbKeyQuery).data;
  const found = useQuery({
    ...tmdbPeopleQuery(key ?? "", term ?? ""),
    enabled: Boolean(enabled && key && term),
  });
  return key && term && enabled ? found.data : undefined;
}
