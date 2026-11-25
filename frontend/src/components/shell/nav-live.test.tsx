import { screen, waitFor, within } from "@testing-library/react";
import { CancellablePromise } from "@wailsio/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Profile } from "@bindings/store";
import { LiveTV, type Source } from "@/lib/livetv";
import { deviceSettings, profileSettings } from "@/test/fixtures";
import { onCompactIOS } from "@/test/ios";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({ current: vi.fn<() => Promise<Profile>>() }));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((profile) => [profile]),
    CurrentProfile: mocks.current,
    Addons: async () => [],
    VisibleAddons: async () => [],
    CatalogVisible: async () => true,
    HomeLayout: async () => null,
    Collections: async () => [],
    Library: async () => [],
    LastWatched: async () => ({}),
    ContinueWatching: async () => [],
    ProfileSettings: async () => profileSettings(),
    DeviceSettings: async () => deviceSettings(),
    // On iOS the shell seeds the profile's audio languages once it is in use
    // (lib/device-languages): without it the app falls to its error screen.
    SeedAudioLanguages: async () => {},
  },
}));

// No TMDB key: the title-page prefetch in the shell asks the keychain.
vi.mock("@bindings/secrets", () => ({ Service: { Get: async () => null } }));

vi.mock("@bindings/account", () => ({
  Service: { Status: async () => ({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: async () => Promise.reject(new Error("offline")),
    Connection: async () => "offline",
    CheckConnection: async () => "offline",
  },
}));

const kevin: Profile = { id: 1, name: "Kevin", nuvioIndex: 1 };
// Kids profiles have no Live TV at all (ADR-0066): Go's guardKids answers
// them nothing, and the frontend never even asks.
const sam: Profile = { id: 5, name: "Sam", nuvioIndex: 5, kids: true };

// A source as Go's Source answers it, with every field filled.
function source(changes: Partial<Source> = {}): Source {
  const at = Date.UTC(2026, 10, 20, 9, 0);
  return {
    id: "src-1",
    profileId: kevin.id,
    name: "Freeview",
    createdAt: at,
    updatedAt: at + 60_000,
    hasGuide: true,
    guideFromPlaylist: false,
    channels: 120,
    guideChannels: 110,
    programmes: 4_800,
    playlistAt: at,
    guideAt: at + 30_000,
    playlistError: "",
    guideError: "",
    refreshing: false,
    ...changes,
  };
}

// What Go answers Sources with: the setup's default is none (src/test/setup.ts).
const answers = (sources: Source[]) =>
  vi
    .mocked(LiveTV.Sources)
    .mockImplementation(() => CancellablePromise.resolve<Source[] | null>(sources));

const nav = () => screen.getByRole("navigation", { name: "Main" });
const labels = () =>
  within(nav())
    .getAllByRole("link")
    .map((link) => link.textContent);

let restoreCompact: (() => void) | undefined;

beforeEach(() => {
  mocks.current.mockResolvedValue(kevin);
  answers([]);
});

afterEach(() => {
  restoreCompact?.();
  restoreCompact = undefined;
});

describe("the Live TV nav entry", () => {
  it("stays out of the nav while the profile has no source", async () => {
    await renderApp("/");
    await waitFor(() => expect(LiveTV.Sources).toHaveBeenCalledWith(kevin.id));

    expect(labels()).toEqual(["Home", "Movies", "Shows", "Anime", "Library", "Search"]);
    expect(within(nav()).queryByRole("link", { name: "Live TV" })).toBeNull();
  });

  it("joins the nav before Library once the profile has a source", async () => {
    answers([source()]);

    await renderApp("/");

    await waitFor(() =>
      expect(labels()).toEqual([
        "Home",
        "Movies",
        "Shows",
        "Anime",
        "Live TV",
        "Library",
        "Search",
      ]),
    );
    expect(within(nav()).getByRole("link", { name: "Live TV" }).getAttribute("href")).toMatch(
      /\/live$/,
    );
  });

  it("never offers Live TV to a kids profile, nor asks Go for its sources", async () => {
    answers([source({ profileId: sam.id })]);
    mocks.current.mockResolvedValue(sam);

    await renderApp("/");

    expect(screen.queryByRole("link", { name: "Live TV" })).toBeNull();
    expect(LiveTV.Sources).not.toHaveBeenCalledWith(sam.id);
  });

  it("is a tab in the compact tab bar", async () => {
    restoreCompact = onCompactIOS();
    answers([source()]);

    await renderApp("/");

    const bar = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(within(bar).getByRole("link", { name: "Live TV" })).toBeInTheDocument(),
    );
  });
});
