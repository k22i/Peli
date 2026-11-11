import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, Profile } from "@bindings/store";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({ current: vi.fn<() => Promise<Profile>>() }));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: () => Promise.resolve([cinemeta]),
    VisibleAddons: () => Promise.resolve([cinemeta]),
    CatalogVisible: () => Promise.resolve(true),
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
    ContinueWatching: () => Promise.resolve([]),
    Library: () => Promise.resolve([]),
    TitleWatched: () => Promise.resolve([]),
    TitleProgress: () => Promise.resolve([]),
  },
}));

const keychain = vi.hoisted(() => ({ tmdb: null as string | null }));
vi.mock("@bindings/secrets", () => ({
  Service: { Get: (key: string) => Promise.resolve(key === "tmdb.api-key" ? keychain.tmdb : null) },
}));
vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));
vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.reject(new Error("offline")),
    Connection: () => Promise.resolve("online"),
    CheckConnection: () => Promise.resolve("online"),
  },
}));

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;
const cinemeta: Addon = {
  url: "https://v3-cinemeta.strem.io/manifest.json",
  name: "Cinemeta",
  enabled: true,
};

const tmdb = "https://api.themoviedb.org/3";
const personUrl = `${tmdb}/person/287?append_to_response=combined_credits%2Cexternal_ids%2Cimages&api_key=key`;
const bio = "An American actor. ".repeat(30);

const answer = {
  id: 287,
  name: "Brad Pitt",
  known_for_department: "Acting",
  biography: bio,
  birthday: "1963-12-18",
  place_of_birth: "Shawnee, Oklahoma, USA",
  profile_path: "/brad.jpg",
  combined_credits: {
    cast: [
      {
        id: 550,
        media_type: "movie",
        title: "Fight Club",
        character: "Tyler Durden",
        release_date: "1999-10-15",
        popularity: 90,
      },
      {
        id: 16,
        media_type: "movie",
        title: "Old Film",
        character: "Extra",
        release_date: "1988-01-01",
        popularity: 5,
      },
      {
        id: 77,
        media_type: "tv",
        name: "Friends",
        character: "Will",
        first_air_date: "2001-11-22",
        popularity: 40,
      },
    ],
    crew: [
      {
        id: 800,
        media_type: "movie",
        title: "Moonlight",
        job: "Producer",
        department: "Production",
      },
      {
        id: 801,
        media_type: "movie",
        title: "Directed One",
        job: "Director",
        department: "Directing",
        release_date: "2020-01-01",
      },
    ],
  },
};

// Answers by full URL; the rest is a 503. Wails' own calls pass URL objects.
function serve(answers: Record<string, unknown>) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    ...answers,
  };
  const fetch = vi.fn<(url: string | URL) => Promise<Response>>(async (input) => {
    const url = String(input);
    return url in all ? Response.json(all[url]) : new Response("", { status: 503 });
  });
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.map(([url]) => String(url));
}

const titles = (group: string) =>
  within(screen.getByRole("region", { name: group }))
    .getAllByRole("button")
    .map((button) => button.textContent);

// The first render loads the route chunks cold, which can pass the default 1s.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  keychain.tmdb = "key";
  mocks.current.mockResolvedValue(kevin);
});

describe("person page", () => {
  it("shows the bio, facts and the filmography by kind of work", async () => {
    serve({ [personUrl]: answer });
    await renderApp("/person/287");

    expect(await screen.findByRole("heading", { name: "Brad Pitt", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/^Born .*1963 in Shawnee, Oklahoma, USA$/)).toBeInTheDocument();
    expect(screen.getByText("Acting", { selector: "p" })).toBeInTheDocument();
    // The long biography is clamped until asked for.
    const more = screen.getByRole("button", { name: "Read more" });
    await userEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Acting",
      "Directing",
      "Production",
    ]);
    // Most popular first; each card says the year and the role.
    expect(titles("Acting")).toEqual([
      expect.stringContaining("Fight Club"),
      expect.stringContaining("Friends"),
      expect.stringContaining("Old Film"),
    ]);
    expect(titles("Acting")[0]).toContain("1999 · Tyler Durden");
    expect(titles("Directing")[0]).toContain("Directed One");
  });

  it("sorts by newest", async () => {
    serve({ [personUrl]: answer });
    await renderApp("/person/287");

    await userEvent.click(await screen.findByRole("button", { name: "Newest" }));
    await waitFor(() =>
      expect(titles("Acting")).toEqual([
        expect.stringContaining("Friends"),
        expect.stringContaining("Fight Club"),
        expect.stringContaining("Old Film"),
      ]),
    );
  });

  it("opens a title in Sinag by its IMDb id", async () => {
    const asked = serve({
      [personUrl]: answer,
      [`${tmdb}/movie/550/external_ids?api_key=key`]: { imdb_id: "tt0137523" },
    });
    await renderApp("/person/287");

    await userEvent.click(await screen.findByRole("button", { name: /Fight Club/ }));
    await waitFor(() =>
      expect(asked()).toContain("https://v3-cinemeta.strem.io/meta/movie/tt0137523.json"),
    );
  });

  it("says how to add a TMDB key, and asks nothing, without one", async () => {
    keychain.tmdb = null;
    const asked = serve({});
    await renderApp("/person/287");

    expect(await screen.findByText("People come from TMDB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open settings" })).toHaveAttribute(
      "href",
      expect.stringContaining("section=content"),
    );
    expect(asked().some((url) => url.includes("themoviedb"))).toBe(false);
  });

  it("lists no films or series on a kids profile", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    serve({ [personUrl]: answer });
    await renderApp("/person/287");

    expect(await screen.findByRole("heading", { name: "Brad Pitt", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/aren’t shown on a kids profile/)).toBeInTheDocument();
    expect(screen.queryByText("Fight Club")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Acting" })).toBeNull();
  });

  it("says when TMDB doesn't know the person", async () => {
    serve({ [personUrl]: { success: false } });
    await renderApp("/person/287");

    expect(await screen.findByText("TMDB doesn’t know this person")).toBeInTheDocument();
  });
});
