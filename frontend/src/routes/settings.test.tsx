import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DeviceSettings, Profile, ProfileSettings } from "@bindings/store";
import type { Connections } from "@bindings/tracking";
import { hasFocusRing, keyboardReachable } from "@/test/focus";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

vi.mock("@bindings/licences", () => ({
  Service: {
    Notices: async () => ({
      app: {
        kind: "app",
        name: "Sinag",
        version: "",
        licence: "MIT",
        text: "Permission is hereby granted",
      },
      components: [
        {
          kind: "native",
          name: "libmpv and FFmpeg",
          version: "",
          licence: "LGPL-2.1-or-later",
          text: "GNU LESSER GENERAL PUBLIC LICENSE",
        },
        {
          kind: "npm",
          name: "react",
          version: "19.3.0",
          licence: "MIT",
          text: "React licence text",
        },
      ],
    }),
  },
}));

const torrents = vi.hoisted(() => ({
  cache: 3_200_000_000,
  setCacheSize: vi.fn<(gb: number) => Promise<void>>(async () => {}),
}));

vi.mock("@bindings/torrent", () => ({
  Service: {
    CacheSize: async () => torrents.cache,
    ClearCache: async () => {
      torrents.cache = 0;
    },
    SetCacheSize: torrents.setCacheSize,
  },
}));

// SIMKL and AniList (#71): Go's connections for the profile, and the calls
// Settings makes.
const trackers = vi.hoisted(() => ({
  connections: undefined as Connections | undefined,
  calls: [] as string[],
  // Resolves the pending sign-in's wait.
  approve: undefined as (() => void) | undefined,
  status(): Connections {
    return (
      this.connections ?? {
        simklAvailable: true,
        anilistAvailable: true,
        kids: false,
        simkl: null,
        anilist: null,
      }
    );
  },
  record<T>(name: string, answer: () => T) {
    return async (...args: unknown[]) => {
      this.calls.push(`${name}(${args.join(",")})`);
      return answer();
    };
  },
}));

vi.mock("@bindings/tracking", () => {
  const record = trackers.record.bind(trackers);
  return {
    Service: {
      Status: async () => trackers.status(),
      ImportSoon: record("ImportSoon", () => undefined),
      Import: record("Import", () => ({ simkl: 0, anilist: 0 })),
      StartSimkl: record("StartSimkl", () => ({
        code: "BDWP-HQPK",
        url: "https://simkl.com/pin?user_code=BDWP-HQPK",
        pageUrl: "https://simkl.com/pin",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      })),
      WaitSimkl: () =>
        new Promise<Connections>((resolve) => {
          trackers.approve = () => {
            trackers.connections = {
              ...trackers.status(),
              simkl: { user: "kevin", needsReconnect: false, importedAt: 0 },
            };
            resolve(trackers.connections);
          };
        }),
      CancelSimkl: record("CancelSimkl", () => undefined),
      DisconnectSimkl: record("DisconnectSimkl", () => {
        trackers.connections = { ...trackers.status(), simkl: null };
        return trackers.connections;
      }),
      StartAniList: record("StartAniList", () => "https://anilist.co/api/v2/oauth/authorize"),
      WaitAniList: () => new Promise(() => {}),
      CancelAniList: record("CancelAniList", () => undefined),
      DisconnectAniList: record("DisconnectAniList", () => trackers.status()),
    },
  };
});

const browser = vi.hoisted(() => ({
  openURL: vi.fn<(url: string) => Promise<void>>(async () => {}),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Browser: { OpenURL: browser.openURL },
}));

// An in-memory stand-in for the Go store, with its defaults
// (internal/store/settings.go).
const store = vi.hoisted(() => ({
  profiles: [] as Profile[],
  current: 0,
  profileSettings: new Map<number, ProfileSettings>(),
  device: undefined as DeviceSettings | undefined,
  failSaves: false,
  async save(apply: () => void) {
    if (this.failSaves) throw new Error("disk full");
    apply();
  },
}));

vi.mock("@bindings/store", () => {
  const defaults: ProfileSettings = {
    audioLanguage: "",
    subtitleLanguage: "",
    subtitleSize: "medium",
    captions: "system",
    skipIntros: false,
    simklScrobble: true,
    simklImport: true,
    simklAnime: true,
    anilistProgress: true,
    anilistImport: true,
    animeInMoviesAndShows: false,
  };
  return {
    Service: {
      CurrentProfile: async () => store.profiles[store.current],
      Addons: async () => [{ url: "https://cinemeta/manifest.json", enabled: true }],
      ProfileSettings: async (id: number) => store.profileSettings.get(id) ?? defaults,
      SaveProfileSettings: (id: number, settings: ProfileSettings) =>
        store.save(() => store.profileSettings.set(id, settings)),
      DeviceSettings: async () =>
        store.device ?? {
          hardwareDecoding: true,
          skipTimesOnline: true,
          diagnostics: false,
          torrentStreaming: false,
          torrentCacheGB: 5,
        },
      SaveDeviceSettings: (settings: DeviceSettings) =>
        store.save(() => {
          store.device = settings;
        }),
    },
  };
});

beforeEach(() => {
  store.profiles = [
    { id: 1, name: "Guest" },
    { id: 2, name: "Ben Ito" },
  ];
  store.current = 0;
  store.profileSettings.clear();
  store.device = undefined;
  store.failSaves = false;
  torrents.cache = 3_200_000_000;
  torrents.setCacheSize.mockClear();
  trackers.connections = undefined;
  trackers.calls = [];
  trackers.approve = undefined;
  browser.openURL.mockClear();
});

const sectionTitles = [
  "Account & profiles",
  "Addons",
  "Playback",
  "Subtitles",
  "Appearance",
  "Integrations",
  "Privacy",
  "About",
];

async function renderSettings() {
  const result = await renderApp("/settings");
  await screen.findByRole("switch", { name: "Hardware decoding" });
  return result;
}

describe("settings", () => {
  it("shows every section with the defaults", async () => {
    await renderSettings();

    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      sectionTitles,
    );
    expect(screen.getByRole("switch", { name: "Hardware decoding" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Share diagnostics" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Audio language" })).toHaveTextContent("Original");
    expect(screen.getByRole("combobox", { name: "Subtitle language" })).toHaveTextContent(
      "Automatic",
    );
    const size = screen.getByRole("group", { name: "Size" });
    expect(within(size).getByRole("button", { name: "Medium" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("1 addon installed")).toBeInTheDocument();
    expect(await screen.findByText("1.2.3")).toBeInTheDocument();
    // The welcome screen's words (#39).
    expect(screen.getByText(/^Sinag comes with no addons and doesn’t host/)).toBeInTheDocument();
  });

  // Addons hold the debrid keys (#54, ADR-0038): the row points there and
  // asks for nothing.
  it("sends debrid setup to the addons", async () => {
    await renderSettings();

    expect(
      screen.getByText(/^Set up TorBox, AllDebrid or Premiumize in a stream addon/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Open addons" })).toHaveAttribute("href", "/addons");
  });

  it("shows Sinag's licence and the third-party notices", async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.click(screen.getByRole("button", { name: "Licences" }));

    const dialog = await screen.findByRole("dialog", { name: "Licences" });
    expect(await within(dialog).findByText("Permission is hereby granted")).toBeVisible();
    expect(within(dialog).getByText("libmpv and FFmpeg")).toBeInTheDocument();
    expect(within(dialog).getByText("LGPL-2.1-or-later · Playback engine")).toBeInTheDocument();
    expect(within(dialog).getByText("react 19.3.0")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("is fully keyboard-operable", async () => {
    const user = userEvent.setup();
    await renderSettings();

    // Switches toggle with Space.
    const hardwareDecoding = screen.getByRole("switch", { name: "Hardware decoding" });
    hardwareDecoding.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(store.device?.hardwareDecoding).toBe(false));
    expect(hardwareDecoding).not.toBeChecked();

    // Tab moves on to the language select, which opens and picks with keys.
    await user.tab();
    const audio = screen.getByRole("combobox", { name: "Audio language" });
    expect(audio).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    const japanese = await screen.findByRole("option", { name: "Japanese" });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeVisible());
    // Typeahead jumps to the option; Enter picks it.
    await user.keyboard("Jap");
    await waitFor(() => expect(japanese).toHaveAttribute("data-highlighted"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(store.profileSettings.get(1)?.audioLanguage).toBe("ja"));
    expect(audio).toHaveTextContent("Japanese");

    // Segmented controls move with arrow keys and press with Space.
    const size = screen.getByRole("group", { name: "Size" });
    within(size).getByRole("button", { name: "Medium" }).focus();
    await user.keyboard("{ArrowRight} ");
    await waitFor(() => expect(store.profileSettings.get(1)?.subtitleSize).toBe("large"));
    expect(within(size).getByRole("button", { name: "Large" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("gives every keyboard-reachable element a visible focus ring", async () => {
    await renderSettings();

    const elements = keyboardReachable();
    expect(elements.length).toBeGreaterThan(20);
    const missing = elements.filter((element) => !hasFocusRing(element));
    expect(missing.map((element) => element.outerHTML.slice(0, 120))).toEqual([]);
  });

  it("jumps to a section from the section list", async () => {
    const user = userEvent.setup();
    await renderSettings();

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    within(nav).getByRole("button", { name: "Privacy" }).focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("heading", { level: 2, name: "Privacy" })).toHaveFocus();
  });

  it("keeps profile settings per profile and device settings for everyone", async () => {
    const user = userEvent.setup();
    const first = await renderSettings();
    await user.click(screen.getByRole("switch", { name: "Share diagnostics" }));
    await user.click(screen.getByRole("button", { name: "Off" }));
    await waitFor(() => expect(store.profileSettings.get(1)?.captions).toBe("off"));
    expect(store.device?.diagnostics).toBe(true);
    first.unmount();

    // Another profile: its own subtitles, the same device.
    store.current = 1;
    await renderSettings();
    expect(screen.getByRole("switch", { name: "Share diagnostics" })).toBeChecked();
    const captions = screen.getByRole("group", { name: "Captions" });
    expect(within(captions).getByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(store.profileSettings.has(2)).toBe(false);
  });

  it("streams torrents only once turned on, with a cache to size and clear", async () => {
    const user = userEvent.setup();
    await renderSettings();
    const streaming = screen.getByRole("switch", { name: "Stream torrents" });
    expect(streaming).not.toBeChecked();
    expect(streaming).toHaveAccessibleDescription(/can see your IP address/);
    expect(screen.queryByRole("combobox", { name: "Torrent cache" })).not.toBeInTheDocument();

    await user.click(streaming);
    await waitFor(() => expect(store.device?.torrentStreaming).toBe(true));
    const cache = await screen.findByRole("combobox", { name: "Torrent cache" });
    expect(cache).toHaveTextContent("5 GB");
    expect(cache).toHaveAccessibleDescription(/3\.2 GB used/);

    await user.click(cache);
    await user.click(await screen.findByRole("option", { name: "20 GB" }));
    await waitFor(() => expect(store.device?.torrentCacheGB).toBe(20));
    expect(torrents.setCacheSize).toHaveBeenCalledExactlyOnceWith(20);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(cache).toHaveAccessibleDescription(/0 B used/));
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("puts a setting back if saving it fails", async () => {
    const user = userEvent.setup();
    await renderSettings();
    store.failSaves = true;

    const diagnostics = screen.getByRole("switch", { name: "Share diagnostics" });
    await user.click(diagnostics);
    await waitFor(() => expect(diagnostics).not.toBeChecked());
    expect(store.device).toBeUndefined();
  });
  // SIMKL's device sign-in (#72): the page opens with the code filled in,
  // the code shows for another device, and the row then shows the account.
  it("connects SIMKL and shows its settings", async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.click(await screen.findByRole("button", { name: "Connect SIMKL" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect SIMKL" });
    expect(await within(dialog).findByText("BDWP-HQPK")).toBeVisible();
    expect(browser.openURL).toHaveBeenCalledWith("https://simkl.com/pin?user_code=BDWP-HQPK");
    expect(trackers.calls).toContain("StartSimkl(1)");

    trackers.approve?.();
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(await screen.findByText(/^Connected as kevin\./)).toBeVisible();
    for (const name of ["Scrobble", "Import watched history", "Include anime"]) {
      expect(screen.getByRole("switch", { name })).toBeChecked();
    }

    // Turning the import back on brings in what's there now.
    await user.click(screen.getByRole("switch", { name: "Import watched history" }));
    expect(trackers.calls).not.toContain("Import(1)");
    await user.click(screen.getByRole("switch", { name: "Import watched history" }));
    await waitFor(() => expect(trackers.calls).toContain("Import(1)"));
    expect(store.profileSettings.get(1)?.simklImport).toBe(true);

    await user.click(screen.getByRole("button", { name: "Disconnect SIMKL" }));
    expect(await screen.findByRole("button", { name: "Connect SIMKL" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Scrobble" })).not.toBeInTheDocument();
  });

  it("cancels a SIMKL sign-in when the dialog closes", async () => {
    const user = userEvent.setup();
    await renderSettings();
    await user.click(await screen.findByRole("button", { name: "Connect SIMKL" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect SIMKL" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trackers.calls).toContain("CancelSimkl()"));
  });

  it("opens AniList's approval page to connect", async () => {
    const user = userEvent.setup();
    await renderSettings();
    await user.click(await screen.findByRole("button", { name: "Connect AniList" }));
    expect(await screen.findByRole("dialog", { name: "Connect AniList" })).toBeVisible();
    await waitFor(() =>
      expect(browser.openURL).toHaveBeenCalledWith("https://anilist.co/api/v2/oauth/authorize"),
    );
  });

  it("asks to reconnect when a sign-in stopped working", async () => {
    trackers.connections = {
      simklAvailable: true,
      anilistAvailable: true,
      kids: false,
      simkl: { user: "kevin", needsReconnect: true, importedAt: 0 },
      anilist: { user: "kev", needsReconnect: true, expires: 0, importedAt: 0 },
    };
    await renderSettings();
    expect(await screen.findByRole("button", { name: "Reconnect SIMKL" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reconnect AniList" })).toBeVisible();
  });

  it("doesn't offer trackers to kids profiles", async () => {
    trackers.connections = {
      simklAvailable: true,
      anilistAvailable: true,
      kids: true,
      simkl: null,
      anilist: null,
    };
    await renderSettings();
    expect(await screen.findByText("Kids profiles don’t connect to trackers.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect SIMKL" })).not.toBeInTheDocument();
  });
});
