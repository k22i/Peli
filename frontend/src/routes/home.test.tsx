import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import type { LibraryItem, Profile, Progress } from "@bindings/store";
import type * as Runtime from "@wailsio/runtime";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { data: unknown }) => void>(),
  library: vi.fn<() => Promise<LibraryItem[]>>(),
  continueWatching: vi.fn<() => Promise<Progress[]>>(),
  connection: vi.fn<() => Promise<string>>(),
  checkConnection: vi.fn<() => Promise<string>>(),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: (event: { data: unknown }) => void) => {
        mocks.handlers.set(name, callback);
        return () => mocks.handlers.delete(name);
      },
    },
  };
});

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => Promise.resolve([kevin]),
    CurrentProfile: () => Promise.resolve(kevin),
    Library: mocks.library,
    ContinueWatching: mocks.continueWatching,
  },
}));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.reject(new Error("offline")),
    Connection: mocks.connection,
    CheckConnection: mocks.checkConnection,
  },
}));

const dune: LibraryItem = {
  contentId: "tt1160419",
  contentType: "movie",
  name: "Dune",
  releaseInfo: "2021",
  addedAt: 2000,
};
const severance: LibraryItem = {
  contentId: "tt11280740",
  contentType: "series",
  name: "Severance",
  addedAt: 1000,
};
const episode: Progress = {
  key: "tt11280740_s1e2",
  contentId: "tt11280740",
  contentType: "series",
  videoId: "tt11280740:1:2",
  season: 1,
  episode: 2,
  position: 600_000,
  duration: 3_000_000,
  lastWatched: 5_000_000,
};

const row = (name: string) => screen.findByRole("region", { name });

describe("Home", () => {
  // The acceptance criterion: with no network, Home opens with the library
  // and Continue Watching, and says it's offline without getting in the way.
  it("opens offline with the library and Continue Watching from the store", async () => {
    mocks.library.mockResolvedValue([dune, severance]);
    mocks.continueWatching.mockResolvedValue([episode]);
    mocks.connection.mockResolvedValue("offline");

    await renderApp("/");

    const watching = await row("Continue watching");
    const card = within(watching).getByRole("button", { name: /Severance/ });
    expect(card).toHaveTextContent("S1 · E2");
    expect(card).toHaveTextContent("20% watched");
    const library = await row("Your library");
    expect(
      within(library)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("Dune"), expect.stringContaining("Severance")]);
    expect(await screen.findByRole("button", { name: /^Offline\./ })).toBeInTheDocument();
    expect(mocks.library).toHaveBeenCalledWith(1);
  });

  it("refreshes when a pull brings something in", async () => {
    mocks.library.mockResolvedValue([dune]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("online");

    await renderApp("/");
    await row("Your library");
    expect(screen.queryByRole("region", { name: "Continue watching" })).toBeNull();

    mocks.continueWatching.mockResolvedValue([episode]);
    mocks.handlers.get("sync:pulled")?.({ data: { profileId: 1, surfaces: ["progress"] } });

    expect(await row("Continue watching")).toBeInTheDocument();
  });

  it("says what will show up when there's nothing yet", async () => {
    mocks.library.mockResolvedValue([]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("online");

    await renderApp("/");

    expect(await screen.findByText("Titles you save and watch show up here.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  });
});

describe("offline indicator", () => {
  it("checks again when clicked and goes away once back online", async () => {
    const user = userEvent.setup();
    mocks.library.mockResolvedValue([dune]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("offline");
    mocks.checkConnection.mockResolvedValueOnce("offline").mockResolvedValueOnce("online");

    await renderApp("/");
    const indicator = await screen.findByRole("button", { name: /^Offline\./ });

    await user.click(indicator);
    await waitFor(() => expect(mocks.checkConnection).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /^Offline\./ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Offline\./ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Offline\./ })).toBeNull());
  });

  it("follows Go's connection events, and checks when the webview goes online", async () => {
    mocks.library.mockResolvedValue([dune]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("online");
    mocks.checkConnection.mockReset().mockResolvedValue("online");

    await renderApp("/");
    await row("Your library");
    expect(screen.queryByRole("button", { name: /^Offline\./ })).toBeNull();

    mocks.handlers.get("sync:connection")?.({ data: "unavailable" });
    expect(await screen.findByRole("button", { name: /^Nuvio is down\./ })).toBeInTheDocument();

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(mocks.checkConnection).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Nuvio is down\./ })).toBeNull(),
    );
  });
});
