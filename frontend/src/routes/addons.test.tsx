import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, Profile } from "@bindings/store";
import type * as Runtime from "@wailsio/runtime";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { data: unknown }) => void>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  current: vi.fn<() => Promise<Profile>>(),
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
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: mocks.addons,
  },
}));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.resolve({ profileId: 1, surfaces: [] }),
    Connection: () => Promise.resolve("online"),
    CheckConnection: () => Promise.resolve("online"),
  },
}));

const cinemeta: Addon = {
  url: "https://v3-cinemeta.strem.io/manifest.json",
  name: "Cinemeta",
  enabled: true,
};
const broken: Addon = { url: "https://gone.example/manifest.json", name: "Gone", enabled: true };
// Nuvio keeps some addons by their base URL.
const subtitles: Addon = {
  url: "https://opensubtitles-v3.strem.io",
  name: "OpenSubtitles v3",
  enabled: false,
};

const manifests: Record<string, object> = {
  "https://v3-cinemeta.strem.io/manifest.json": {
    id: "com.linvo.cinemeta",
    name: "Cinemeta",
    version: "3.0.13",
  },
  "https://opensubtitles-v3.strem.io/manifest.json": {
    id: "org.stremio.opensubtitlesv3",
    name: "OpenSubtitles v3",
    version: "1.0.0",
  },
};

beforeEach(() => {
  mocks.current.mockResolvedValue(kevin);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const manifest = manifests[url];
      return Promise.resolve(
        manifest ? Response.json(manifest) : new Response("not found", { status: 404 }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const list = () => screen.findByRole("list", { name: "Installed addons" });

describe("Addons", () => {
  // #32: an addon whose manifest doesn't load keeps its place and says why.
  it("lists the synced addons in order, keeping one whose manifest fails", async () => {
    mocks.addons.mockResolvedValue([cinemeta, broken, subtitles]);

    await renderApp("/addons");

    const items = within(await list()).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Cinemeta",
      "Gone",
      "OpenSubtitles v3",
    ]);
    expect(await within(items[0]!).findByText("v3.0.13")).toBeInTheDocument();
    expect(
      await within(items[1]!).findByText(/Couldn’t load its manifest\. The addon answered 404\./),
    ).toHaveTextContent("It stays installed");
    expect(await within(items[2]!).findByText("v1.0.0")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Off")).toBeInTheDocument();
    expect(screen.getByText("The same on every device signed in to Nuvio.")).toBeInTheDocument();
  });

  it("refreshes when a pull brings a new list", async () => {
    mocks.addons.mockResolvedValue([cinemeta]);

    await renderApp("/addons");
    await list();

    mocks.addons.mockResolvedValue([cinemeta, subtitles]);
    mocks.handlers.get("sync:pulled")?.({ data: { profileId: 1, surfaces: ["addons"] } });

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Installed addons" })).getAllByRole("listitem"),
      ).toHaveLength(2),
    );
  });

  it("says when a profile shares the first profile's addons", async () => {
    mocks.current.mockResolvedValue({ ...kevin, id: 3, nuvioIndex: 3, usesPrimaryAddons: true });
    mocks.addons.mockResolvedValue([]);

    await renderApp("/addons");

    expect(await screen.findByText("No addons installed.")).toBeInTheDocument();
    expect(screen.getByText(/Shared with your first Nuvio profile/)).toBeInTheDocument();
  });
});
