import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DeviceSettings, Profile, ProfileSettings } from "@bindings/store";
import type * as PlayerBindings from "@bindings/player";
import type { Connections } from "@bindings/tracking";
import { profileSettings } from "@/test/fixtures";
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
        name: "Peli",
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

// Plugins (#57): off, with nothing installed.
vi.mock("@bindings/plugins", () => ({
  Service: {
    Installed: () => Promise.resolve([]),
    Refresh: () => Promise.resolve(0),
    Overview: () => Promise.resolve({ kids: false, enabled: false, repositories: [] }),
  },
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

// Settings › Playback lists the audio outputs (#sound): none here.
vi.mock("@bindings/player", async (importOriginal) => {
  const actual = await importOriginal<typeof PlayerBindings>();
  return {
    ...actual,
    Service: { ...actual.Service, AudioDevices: () => Promise.resolve([]) },
  };
});

vi.mock("@bindings/store", async () => {
  const defaults = (await import("@/test/fixtures")).profileSettings();
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
          maxResolution: "auto",
          hdr: "auto",
          dolbyVision: "auto",
          skipTimesOnline: true,
          autoUpdate: true,
          diagnostics: false,
          torrentStreaming: false,
          torrentCacheGB: 5,
          preResolve: false,
          streamSort: "best",
          quality: {
            scaling: "balanced",
            deband: "off",
            sharpen: 0,
            upscaler: "off",
            motionSmoothing: false,
            deinterlace: "auto",
            toneMapping: "auto",
            targetPeak: 0,
          },
          audio: { device: "auto", stereoDownmix: false, volumeBoost: false },
          // The party beside the video (ADR-0051), off by default.
          partyDock: false,
        },
      SaveDeviceSettings: (settings: DeviceSettings) =>
        store.save(() => {
          store.device = settings;
        }),
    },
  };
});

// A profile's settings with a few changed, for tests that start from some.
const settingsWith = (changes: Partial<ProfileSettings>): ProfileSettings =>
  profileSettings(changes);

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

const paneTitles = [
  "Account",
  "Addons & content",
  "Playback",
  "Languages & subtitles",
  "Streaming",
  "Downloads",
  "Plugins",
  "Tracking",
  "Privacy",
  "About",
];

// What shows when a pane's rows have loaded.
const ready: Record<string, [role: string, name: string]> = {
  account: ["button", "Change server"],
  content: ["switch", "Show anime in Movies and Shows"],
  playback: ["switch", "Hardware decoding"],
  languages: ["combobox", "Audio languages"],
  streaming: ["switch", "Stream torrents"],
  plugins: ["switch", "Use plugins"],
  tracking: ["heading", "Tracking"],
  privacy: ["switch", "Share diagnostics"],
  about: ["button", "Licences"],
};

// Settings opens on one pane at a time (`?section=`), so each test opens the
// pane its rows are in.
async function renderSettings(section = "playback") {
  const result = await renderApp(`/settings?section=${section}`);
  const [role, name] = ready[section]!;
  await screen.findByRole(role, { name });
  return result;
}

// The group titles on screen.
const groups = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

const paneList = () => screen.getByRole("navigation", { name: "Settings panes" });

describe("settings", () => {
  it("lists the panes and opens the one in ?section=, Account by default", async () => {
    const { router } = await renderApp("/settings");
    await screen.findByRole("button", { name: "Change server" });

    expect(
      within(paneList())
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(paneTitles);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Account",
    ]);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    const current = within(paneList()).getAllByRole("link", { current: "page" });
    expect(current.map((link) => link.textContent)).toEqual(["Account"]);
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("gives only the current pane a sliding pill", async () => {
    await renderSettings("playback");

    const pills = [...paneList().querySelectorAll("[data-settings-pill]")];

    expect(pills).toHaveLength(1);
    expect(within(paneList()).getByRole("link", { name: "Playback" }).contains(pills[0]!)).toBe(
      true,
    );
  });

  it("falls back to Account for a pane that doesn't exist", async () => {
    await renderApp("/settings?section=nope");

    expect(await screen.findByRole("heading", { level: 2, name: "Account" })).toBeInTheDocument();
    expect(within(paneList()).getByRole("link", { name: "Account" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows every row in its pane, with the defaults", async () => {
    const user = userEvent.setup();
    await renderSettings("account");
    const open = async (pane: string) => {
      await user.click(within(paneList()).getByRole("link", { name: pane }));
      expect(await screen.findByRole("heading", { level: 2, name: pane })).toBeInTheDocument();
    };

    expect(groups()).toEqual(["Nuvio", "Profiles"]);
    expect(screen.getByText("Nuvio account")).toBeInTheDocument();
    expect(screen.getByText("Server")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toBeInTheDocument();

    await open("Addons & content");
    expect(groups()).toEqual(["Addons", "Catalogs", "Episodes", "Artwork"]);
    expect(await screen.findByText("1 addon installed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open addons" })).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Show anime in Movies and Shows" }),
    ).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Hide spoilers" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Add TMDB key" })).toBeInTheDocument();

    await open("Playback");
    expect(groups()).toEqual([
      "Video",
      "HDR on a screen without it",
      "Picture",
      "Framing",
      "Sound",
      "Next episode",
      "Intros and credits",
      "Watch party",
    ]);
    expect(await screen.findByRole("switch", { name: "Hardware decoding" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Skip intros automatically" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Look up intro and credits times" })).toBeChecked();
    const stillWatching = screen.getByRole("group", { name: "Ask if you’re still watching" });
    expect(within(stillWatching).getByRole("button", { name: "After 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await open("Languages & subtitles");
    expect(groups()).toEqual(["Languages", "Subtitles"]);
    expect(await screen.findByRole("combobox", { name: "Audio languages" })).toHaveTextContent(
      "Add a language",
    );
    expect(screen.getByRole("combobox", { name: "Subtitle language" })).toHaveTextContent(
      "Automatic",
    );
    // Size, font and colour are in the Look dialog now.
    expect(screen.getByRole("button", { name: "Customise" })).toBeInTheDocument();
    const captions = screen.getByRole("group", { name: "Captions" });
    expect(within(captions).getByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await open("Streaming");
    expect(groups()).toEqual(["Picture", "Starting", "Torrents"]);
    expect(await screen.findByRole("switch", { name: "Stream torrents" })).not.toBeChecked();

    await open("Tracking");
    expect(groups()).toEqual(["SIMKL", "AniList", "Other devices"]);
    expect(await screen.findByRole("button", { name: "Connect SIMKL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect AniList" })).toBeInTheDocument();

    await open("Privacy");
    expect(await screen.findByRole("switch", { name: "Share diagnostics" })).not.toBeChecked();

    await open("About");
    expect(await screen.findByText("1.2.3")).toBeInTheDocument();
    // The welcome screen's words (#39).
    expect(screen.getByText(/^Peli comes with no addons and doesn’t host/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Design system" })).toHaveAttribute("href", "/gallery");
  });

  it("picks a pane from the chip rail in a narrow window", async () => {
    const user = userEvent.setup();
    const { router } = await renderSettings("account");

    const rail = screen.getByRole("group", { name: "Settings panes" });
    expect(within(rail).getByRole("button", { name: "Account" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(rail).getByRole("button", { name: "Privacy" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Privacy" })).toBeVisible();
    expect(router.state.location.search).toEqual({ section: "privacy" });
    expect(within(rail).getByRole("button", { name: "Privacy" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Pressing the current chip keeps the pane.
    await user.click(within(rail).getByRole("button", { name: "Privacy" }));
    expect(router.state.location.search).toEqual({ section: "privacy" });
  });

  it("opens a pane from the pane list with the keyboard", async () => {
    const user = userEvent.setup();
    const { router } = await renderSettings("playback");

    // One Tab stop, on the current pane; arrows move, Enter opens.
    const links = within(paneList()).getAllByRole("link");
    expect(links.filter((link) => link.tabIndex === 0).map((link) => link.textContent)).toEqual([
      "Playback",
    ]);
    const playback = within(paneList()).getByRole("link", { name: "Playback" });
    playback.focus();
    await user.keyboard("{ArrowDown}");
    const languages = within(paneList()).getByRole("link", { name: "Languages & subtitles" });
    expect(languages).toHaveFocus();
    await user.keyboard("{Enter}");

    const heading = await screen.findByRole("heading", { level: 2, name: "Languages & subtitles" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(router.state.location.search).toEqual({ section: "languages" });
    expect(languages).toHaveAttribute("aria-current", "page");
    // Then Tab goes into the pane's rows.
    await user.tab();
    expect(await screen.findByRole("combobox", { name: "Audio languages" })).toHaveFocus();
  });

  it("doesn't move focus when the pane is picked with the pointer", async () => {
    const user = userEvent.setup();
    await renderSettings("playback");

    await user.click(within(paneList()).getByRole("link", { name: "Privacy" }));

    const heading = await screen.findByRole("heading", { level: 2, name: "Privacy" });
    expect(heading).not.toHaveFocus();
  });

  // Spoiler protection is the profile's, off until turned on.
  it("saves Hide spoilers with the profile's settings", async () => {
    const user = userEvent.setup();
    await renderSettings("content");

    const toggle = screen.getByRole("switch", { name: "Hide spoilers" });
    expect(toggle).toHaveAccessibleDescription(/haven’t watched yet/);
    await user.click(toggle);
    await waitFor(() =>
      expect(store.profileSettings.get(store.profiles[store.current]!.id)).toMatchObject({
        hideSpoilers: true,
      }),
    );
    expect(toggle).toBeChecked();
  });

  // Addons hold the debrid keys (#54, ADR-0038): the row points there and
  // asks for nothing.
  it("sends debrid setup to the addons", async () => {
    await renderSettings("content");

    expect(
      screen.getByText(/^Set up TorBox, AllDebrid or Premiumize in a stream addon/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Open addons" })).toHaveAttribute("href", "/addons");
  });

  it("shows Peli's licence and the third-party notices", async () => {
    const user = userEvent.setup();
    await renderSettings("about");

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
    await renderSettings("playback");

    // Switches toggle with Space, and Tab moves on to the next row.
    const hardwareDecoding = screen.getByRole("switch", { name: "Hardware decoding" });
    hardwareDecoding.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(store.device?.hardwareDecoding).toBe(false));
    expect(hardwareDecoding).not.toBeChecked();
    // The next stop is the picture quality choice in the same group.
    await user.tab();
    expect(hardwareDecoding).not.toHaveFocus();
    expect(document.activeElement).toHaveTextContent("Fast");

    // And the switches further down toggle with Space too.
    const skipIntros = screen.getByRole("switch", { name: "Skip intros automatically" });
    skipIntros.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(store.profileSettings.get(1)?.skipIntros).toBe(true));
  });

  it("picks languages and sizes with the keyboard", async () => {
    const user = userEvent.setup();
    await renderSettings("languages");

    // The select that adds an audio language opens and picks with keys.
    const audio = screen.getByRole("combobox", { name: "Audio languages" });
    audio.focus();
    await user.keyboard("{ArrowDown}");
    const japanese = await screen.findByRole("option", { name: "Japanese" });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeVisible());
    // Typeahead jumps to the option; Enter picks it.
    await user.keyboard("Jap");
    await waitFor(() => expect(japanese).toHaveAttribute("data-highlighted"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(store.profileSettings.get(1)?.audioLanguages).toEqual(["ja"]));
    expect(
      screen.getByRole("list", { name: "Audio languages, most preferred first" }),
    ).toHaveTextContent("Japanese");

    // Tab moves on through the language's buttons, then to the next select.
    await user.tab();
    expect(screen.getByRole("button", { name: "Move Japanese earlier" })).toHaveFocus();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("combobox", { name: "Subtitle language" })).toHaveFocus();

    // Segmented controls move with arrow keys and press with Space.
    const captions = screen.getByRole("group", { name: "Captions" });
    within(captions).getByRole("button", { name: "System" }).focus();
    await user.keyboard("{ArrowRight} ");
    await waitFor(() => expect(store.profileSettings.get(1)?.captions).toBe("on"));
    expect(within(captions).getByRole("button", { name: "On" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  // #98: the profile's audio languages, most preferred first.
  it("orders audio languages with buttons the keyboard reaches", async () => {
    const user = userEvent.setup();
    store.profileSettings.set(1, settingsWith({ audioLanguages: ["en", "ja", "ko"] }));
    await renderSettings("languages");
    const list = screen.getByRole("list", { name: "Audio languages, most preferred first" });
    const order = () =>
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent);
    expect(order()).toEqual(["1English", "2Japanese", "3Korean"]);

    // Enter moves a language, and focus stays on its button.
    const korean = within(list).getByRole("button", { name: "Move Korean earlier" });
    korean.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(store.profileSettings.get(1)?.audioLanguages).toEqual(["en", "ko", "ja"]),
    );
    expect(order()).toEqual(["1English", "2Korean", "3Japanese"]);
    expect(korean).toHaveFocus();
    expect(screen.getAllByRole("status").map((status) => status.textContent)).toContain(
      "Korean is number 2 of 3",
    );

    // The first can't go earlier, and the last can't go later.
    const english = within(list).getByRole("button", { name: "Move English earlier" });
    expect(english).toHaveAttribute("aria-disabled", "true");
    english.focus();
    await user.keyboard("{Enter}");
    expect(order()).toEqual(["1English", "2Korean", "3Japanese"]);
    expect(store.profileSettings.get(1)?.audioLanguages).toEqual(["en", "ko", "ja"]);

    // Removing one leaves the add control focused.
    within(list).getByRole("button", { name: "Remove Korean" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(store.profileSettings.get(1)?.audioLanguages).toEqual(["en", "ja"]));
    expect(screen.getByRole("combobox", { name: "Audio languages" })).toHaveFocus();
  });

  it("starts with no audio languages: an add control and no list", async () => {
    await renderSettings("languages");
    expect(screen.queryByRole("list", { name: /Audio languages/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Audio languages" })).toHaveTextContent(
      "Add a language",
    );
  });

  // #98: what this device shows, in words about the device.
  it("sets the maximum resolution, HDR and Dolby Vision for this device", async () => {
    const user = userEvent.setup();
    await renderSettings("streaming");

    const resolution = screen.getByRole("group", { name: "Maximum resolution" });
    expect(within(resolution).getByRole("button", { name: "Auto" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(resolution)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Auto", "4K", "1080p", "720p"]);
    await user.click(within(resolution).getByRole("button", { name: "1080p" }));
    await waitFor(() => expect(store.device?.maxResolution).toBe("1080p"));
    expect(within(resolution).getByRole("button", { name: "1080p" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const hdr = screen.getByRole("group", { name: "HDR" });
    await user.click(within(hdr).getByRole("button", { name: "Off" }));
    await waitFor(() => expect(store.device?.hdr).toBe("off"));

    const dolbyVision = screen.getByRole("group", { name: "Dolby Vision" });
    expect(within(dolbyVision).getByRole("button", { name: "Auto" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(dolbyVision).getByRole("button", { name: "On" }));
    await waitFor(() => expect(store.device?.dolbyVision).toBe("on"));

    // The other device settings stay as they were.
    expect(store.device).toMatchObject({
      hardwareDecoding: true,
      maxResolution: "1080p",
      hdr: "off",
      dolbyVision: "on",
    });
  });

  it("describes the device, not the ranking", async () => {
    await renderSettings("streaming");
    const group = screen.getByRole("region", { name: "Picture" });
    expect(group).toHaveTextContent("Maximum resolution");
    expect(group.textContent).not.toMatch(/score|weight|points/i);
  });

  it("keeps the watch party beside the video, per device", async () => {
    const user = userEvent.setup();
    await renderSettings("playback");

    // Off until it is asked for: the party is the player's sheet until then.
    const dock = screen.getByRole("switch", {
      name: "Keep watch party open beside the video",
    });
    expect(dock).not.toBeChecked();

    await user.click(dock);

    await waitFor(() => expect(store.device?.partyDock).toBe(true));
    expect(dock).toBeChecked();
    // It rides with the rest of this device's settings.
    expect(store.device).toMatchObject({ hardwareDecoding: true, partyDock: true });
  });

  it("gives every keyboard-reachable element a visible focus ring", async () => {
    await renderSettings("languages");

    const elements = keyboardReachable();
    expect(elements.length).toBeGreaterThan(5);
    const missing = elements.filter((element) => !hasFocusRing(element));
    expect(missing.map((element) => element.outerHTML.slice(0, 120))).toEqual([]);
  });

  it("keeps profile settings per profile and device settings for everyone", async () => {
    const user = userEvent.setup();
    const first = await renderSettings("privacy");
    await user.click(screen.getByRole("switch", { name: "Share diagnostics" }));
    await user.click(within(paneList()).getByRole("link", { name: "Languages & subtitles" }));
    await user.click(await screen.findByRole("button", { name: "Off" }));
    await waitFor(() => expect(store.profileSettings.get(1)?.captions).toBe("off"));
    expect(store.device?.diagnostics).toBe(true);
    first.unmount();

    // Another profile: its own subtitles, the same device.
    store.current = 1;
    await renderSettings("privacy");
    expect(screen.getByRole("switch", { name: "Share diagnostics" })).toBeChecked();
    await user.click(within(paneList()).getByRole("link", { name: "Languages & subtitles" }));
    const captions = await screen.findByRole("group", { name: "Captions" });
    expect(within(captions).getByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(store.profileSettings.has(2)).toBe(false);
  });

  it("streams torrents only once turned on, with a cache to size and clear", async () => {
    const user = userEvent.setup();
    await renderSettings("streaming");
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

  it("starts cached streams sooner only once turned on, saying it adds to the debrid list", async () => {
    const user = userEvent.setup();
    await renderSettings("streaming");
    const sooner = screen.getByRole("switch", { name: "Start cached streams sooner" });
    expect(sooner).not.toBeChecked();
    expect(sooner).toHaveAccessibleDescription(
      /adds the stream to your debrid service’s list before you press play/,
    );

    await user.click(sooner);
    await waitFor(() => expect(store.device?.preResolve).toBe(true));
    expect(sooner).toBeChecked();
  });

  it("puts a setting back if saving it fails", async () => {
    const user = userEvent.setup();
    await renderSettings("privacy");
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
    await renderSettings("tracking");

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
    await renderSettings("tracking");
    await user.click(await screen.findByRole("button", { name: "Connect SIMKL" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect SIMKL" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trackers.calls).toContain("CancelSimkl()"));
  });

  it("opens AniList's approval page to connect", async () => {
    const user = userEvent.setup();
    await renderSettings("tracking");
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
    await renderSettings("tracking");
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
    await renderSettings("tracking");
    expect(await screen.findByText("Kids profiles don’t connect to trackers.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect SIMKL" })).not.toBeInTheDocument();
  });
});
