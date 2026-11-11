import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, Profile } from "@bindings/store";
import type * as Runtime from "@wailsio/runtime";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { data: unknown }) => void>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  current: vi.fn<() => Promise<Profile>>(),
  openURL: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
  account: {
    Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }),
    InstallAddon: vi.fn<(id: number, addon: Addon) => Promise<void>>(() => Promise.resolve()),
    InsertAddon: vi.fn<(id: number, addon: Addon, at: number) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    ReconfigureAddon: vi.fn<(id: number, url: string, addon: Addon) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    RemoveAddon: vi.fn<(id: number, url: string) => Promise<void>>(() => Promise.resolve()),
    MoveAddon: vi.fn<(id: number, url: string, to: number) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    EnableAddon: vi.fn<(id: number, url: string, on: boolean) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  },
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Browser: { OpenURL: mocks.openURL },
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

vi.mock("@bindings/account", () => ({ Service: mocks.account }));

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
    types: ["movie", "series"],
    resources: ["subtitles"],
    behaviorHints: { configurable: true },
  },
  "https://opensubtitles-v3.strem.io/lang=fre/manifest.json": {
    id: "org.stremio.opensubtitlesv3",
    name: "OpenSubtitles v3",
    version: "1.0.0",
    types: ["movie", "series"],
    resources: ["subtitles"],
  },
  "https://torrentio.example/manifest.json": {
    id: "com.example.torrentio",
    name: "Torrentio",
    version: "0.0.15",
    description: "Streams from torrents.",
    types: ["movie", "series"],
    resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    catalogs: [],
  },
  "https://aio.example/stremio/manifest.json": {
    id: "com.example.aio",
    name: "AIOStreams",
    version: "2.0.0",
    types: ["movie"],
    resources: ["stream"],
    behaviorHints: { configurable: true, configurationRequired: true },
  },
};
const torrentio: Addon = {
  url: "https://torrentio.example/manifest.json",
  name: "Torrentio",
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
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
const names = () =>
  within(screen.getByRole("list", { name: "Installed addons" }))
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label"));

// A promise to settle later: Go still saving.
function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

// Opens an addon's menu and picks an item, with the keyboard.
async function pick(user: ReturnType<typeof userEvent.setup>, addon: string, item: string) {
  screen.getByRole("button", { name: `More for ${addon}` }).focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  const target = screen.getByRole("menuitem", { name: item });
  // The menu opens on its first item and skips disabled ones.
  const steps = screen
    .getAllByRole("menuitem")
    .filter((el) => el.getAttribute("aria-disabled") !== "true")
    .indexOf(target);
  if (steps > 0) await user.keyboard("{ArrowDown}".repeat(steps));
  await waitFor(() => expect(target).toHaveFocus());
  await user.keyboard("{Enter}");
}

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
    expect(within(items[2]!).getByText("movie, series")).toBeInTheDocument();
    expect(within(items[2]!).getByText("subtitles")).toBeInTheDocument();
    expect(
      within(items[2]!).getByRole("switch", { name: "Use OpenSubtitles v3" }),
    ).not.toBeChecked();
    // The host, never the path, which can hold settings and keys.
    expect(within(items[0]!).getByText("v3-cinemeta.strem.io")).toBeInTheDocument();
    expect(screen.getByText("The same on every device signed in to Nuvio.")).toBeInTheDocument();
  });

  // #122: Peli's own addons carry a neutral badge.
  it("marks an addon that is built into Peli", async () => {
    mocks.addons.mockResolvedValue([
      cinemeta,
      { url: "peli://anilist/manifest.json", name: "AniList", enabled: true },
    ]);

    await renderApp("/addons");

    const items = within(await list()).getAllByRole("listitem");
    expect(within(items[1]!).getByText("Built in")).toBeInTheDocument();
    expect(within(items[0]!).queryByText("Built in")).toBeNull();
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

describe("The addon manager", () => {
  it("installs from a stremio:// link once its manifest reads", async () => {
    mocks.addons.mockResolvedValue([cinemeta]);
    const user = userEvent.setup();
    await renderApp("/addons");
    await list();

    await user.click(screen.getByRole("button", { name: "Install addon" }));
    const dialog = await screen.findByRole("dialog", { name: "Install an addon" });
    await user.type(
      within(dialog).getByLabelText("Address"),
      "stremio://torrentio.example/manifest.json",
    );
    await user.keyboard("{Enter}");

    expect(await within(dialog).findByText("Streams from torrents.")).toBeInTheDocument();
    expect(within(dialog).getByText("stream")).toBeInTheDocument();
    expect(mocks.account.InstallAddon).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Install" }));

    expect(mocks.account.InstallAddon).toHaveBeenCalledWith(1, torrentio);
    expect(await screen.findByText("Installed Torrentio")).toBeInTheDocument();
  });

  it("refuses an address that isn’t an addon, or one already installed", async () => {
    mocks.addons.mockResolvedValue([cinemeta]);
    const user = userEvent.setup();
    await renderApp("/addons");
    await list();

    await user.click(screen.getByRole("button", { name: "Install addon" }));
    const dialog = await screen.findByRole("dialog", { name: "Install an addon" });
    const address = within(dialog).getByLabelText("Address");
    await user.type(address, "https://gone.example");
    await user.click(within(dialog).getByRole("button", { name: "Check" }));
    expect(await within(dialog).findByText("The addon answered 404.")).toBeInTheDocument();

    await user.clear(address);
    await user.type(address, "https://v3-cinemeta.strem.io/manifest.json");
    await user.click(within(dialog).getByRole("button", { name: "Check" }));
    expect(await within(dialog).findByText("Already installed")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Check" })).toBeInTheDocument();
    expect(mocks.account.InstallAddon).not.toHaveBeenCalled();
  });

  it("sends an addon that needs configuring to its configure page", async () => {
    mocks.addons.mockResolvedValue([]);
    const user = userEvent.setup();
    await renderApp("/addons");

    await user.click(await screen.findByRole("button", { name: "Install addon" }));
    const dialog = await screen.findByRole("dialog", { name: "Install an addon" });
    await user.type(within(dialog).getByLabelText("Address"), "https://aio.example/stremio");
    await user.keyboard("{Enter}");

    expect(await within(dialog).findByText("Configure it first")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Open configure page" }));
    expect(mocks.openURL).toHaveBeenCalledWith("https://aio.example/stremio/configure");
    await user.keyboard("{Enter}");
    expect(mocks.account.InstallAddon).not.toHaveBeenCalled();
  });

  it("reconfigures an addon in its place", async () => {
    mocks.addons.mockResolvedValue([cinemeta, subtitles]);
    const user = userEvent.setup();
    await renderApp("/addons");
    await within(await list()).findByText("v1.0.0");

    await pick(user, "OpenSubtitles v3", "Configure…");
    const dialog = await screen.findByRole("dialog", { name: "Configure OpenSubtitles v3" });
    await user.click(within(dialog).getByRole("button", { name: "Open configure page" }));
    expect(mocks.openURL).toHaveBeenCalledWith("https://opensubtitles-v3.strem.io/configure");

    // Another addon's address is refused.
    const address = within(dialog).getByLabelText("Address");
    await user.type(address, "https://torrentio.example/manifest.json{Enter}");
    expect(await within(dialog).findByText("That’s a different addon")).toBeInTheDocument();

    await user.clear(address);
    await user.type(address, "https://opensubtitles-v3.strem.io/lang=fre/manifest.json{Enter}");
    await user.click(await within(dialog).findByRole("button", { name: "Save" }));

    expect(mocks.account.ReconfigureAddon).toHaveBeenCalledWith(1, subtitles.url, {
      url: "https://opensubtitles-v3.strem.io/lang=fre/manifest.json",
      name: "OpenSubtitles v3",
      enabled: false,
    });
  });

  it("reorders with the arrow keys at once, before Go answers", async () => {
    mocks.addons.mockResolvedValue([cinemeta, subtitles, torrentio]);
    const saved = deferred();
    mocks.account.MoveAddon.mockImplementationOnce(() => saved.promise);
    const user = userEvent.setup();
    await renderApp("/addons");
    await list();

    screen.getByRole("button", { name: "Reorder Cinemeta" }).focus();
    await user.keyboard("{ArrowDown}");

    expect(names()).toEqual(["OpenSubtitles v3", "Cinemeta", "Torrentio"]);
    expect(screen.getByRole("button", { name: "Reorder Cinemeta" })).toHaveFocus();
    expect(screen.getByText("Cinemeta moved to position 2 of 3.")).toBeInTheDocument();
    expect(mocks.account.MoveAddon).toHaveBeenCalledWith(1, cinemeta.url, 1);
    saved.resolve();

    await user.keyboard("{End}");
    expect(mocks.account.MoveAddon).toHaveBeenLastCalledWith(1, cinemeta.url, 2);
    await pick(user, "Torrentio", "Move to top");
    expect(mocks.account.MoveAddon).toHaveBeenLastCalledWith(1, torrentio.url, 0);
  });

  it("puts the order back when Go refuses a move", async () => {
    mocks.addons.mockResolvedValue([cinemeta, subtitles]);
    mocks.account.MoveAddon.mockRejectedValueOnce(
      new Error("gone", { cause: { code: "addon_not_found" } }),
    );
    const user = userEvent.setup();
    await renderApp("/addons");
    await list();

    screen.getByRole("button", { name: "Reorder OpenSubtitles v3" }).focus();
    await user.keyboard("{ArrowUp}");

    expect(await screen.findByText("This addon is gone")).toBeInTheDocument();
    expect(names()).toEqual(["Cinemeta", "OpenSubtitles v3"]);
  });

  it("reorders by dragging the grip", async () => {
    mocks.addons.mockResolvedValue([cinemeta, subtitles, torrentio]);
    await renderApp("/addons");
    const rows = within(await list()).getAllByRole("listitem");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Reorder Torrentio" }));
    fireEvent.dragStart(rows[2]!, { dataTransfer: { types: [], setData: () => {} } });
    mocks.account.MoveAddon.mockImplementationOnce(() => {
      mocks.addons.mockResolvedValue([cinemeta, torrentio, subtitles]);
      return Promise.resolve();
    });
    // jsdom has no DragEvent, so no pointer position: the drop lands after
    // the row it is over.
    fireEvent.dragOver(rows[0]!, { dataTransfer: { types: [] } });
    fireEvent.drop(rows[0]!, { dataTransfer: { types: [] } });

    await waitFor(() => expect(mocks.account.MoveAddon).toHaveBeenCalledWith(1, torrentio.url, 1));
    await waitFor(() => expect(names()).toEqual(["Cinemeta", "Torrentio", "OpenSubtitles v3"]));
  });

  it("turns an addon off and on", async () => {
    mocks.addons.mockResolvedValue([cinemeta]);
    const user = userEvent.setup();
    await renderApp("/addons");
    await list();

    await user.click(screen.getByRole("switch", { name: "Use Cinemeta" }));
    expect(mocks.account.EnableAddon).toHaveBeenCalledWith(1, cinemeta.url, false);
  });

  it("removes an addon, and undo puts it back in its place", async () => {
    mocks.addons.mockResolvedValue([cinemeta, subtitles, torrentio]);
    const user = userEvent.setup();
    await renderApp("/addons");
    await list();

    await pick(user, "OpenSubtitles v3", "Remove");
    expect(mocks.account.RemoveAddon).toHaveBeenCalledWith(1, subtitles.url);
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    expect(mocks.account.InsertAddon).toHaveBeenCalledWith(1, subtitles, 1);
  });

  it("asks for the parent PIN again once its approval has run out", async () => {
    mocks.current.mockResolvedValue({ ...kevin, id: 4, nuvioIndex: 4, kids: true });
    mocks.addons.mockResolvedValue([cinemeta]);
    mocks.account.EnableAddon.mockRejectedValueOnce(
      new Error("parent", { cause: { code: "parent_pin_required" } }),
    );
    const user = userEvent.setup();
    await renderApp("/addons");
    await list();

    await user.click(screen.getByRole("switch", { name: "Use Cinemeta" }));
    expect(await screen.findByRole("dialog", { name: "Enter parent PIN" })).toBeInTheDocument();
  });
});
