import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Profile } from "@bindings/store";
import { compactQuery } from "@/lib/shell-mode";
import { hideTabBar } from "@/lib/tab-bar";
import { onIOS } from "@/test/ios";
import { renderApp } from "@/test/render-app";

// The iOS app (ADR-0055) has no updates, plugins or torrent services: a call
// to one rejects with "unknown bound method id". These stand-ins fail the
// same way and count the calls, so a screen that makes one shows here. Watch
// parties used to be on this list; they are bound on iOS now (ADR-0063), so
// src/test/setup.ts's mock answers them.
const unbound = vi.hoisted(() => {
  const state = { calls: [] as string[] };
  const notBound = (service: string) => ({
    Service: new Proxy(
      {},
      {
        get: (_, method) => () => {
          state.calls.push(`${service}.${String(method)}`);
          return Promise.reject(new Error("unknown bound method id"));
        },
      },
    ),
  });
  return { state, notBound };
});

vi.mock("@bindings/updates", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...unbound.notBound("updates"),
}));
vi.mock("@bindings/plugins", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...unbound.notBound("plugins"),
}));
vi.mock("@bindings/torrent", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...unbound.notBound("torrent"),
}));

// No TMDB key: the shell's title prefetch reads the keychain on every route.
vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: () => Promise.resolve("1.2.3") },
}));

const kevin = { id: 1, name: "Kevin", signedIn: true } as Profile;

vi.mock("@bindings/store", async () => {
  const defaults = (await import("@/test/fixtures")).profileSettings();
  return {
    Service: {
      Profiles: async () => [kevin],
      CurrentProfile: async () => kevin,
      SeedAudioLanguages: async () => false,
      Addons: async () => [],
      VisibleAddons: async () => [],
      Library: async () => [],
      ContinueWatching: async () => [],
      HomeLayout: async () => null,
      Collections: async () => [],
      ProfileSettings: async () => defaults,
      DeviceSettings: async () => ({
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
        quality: {},
        audio: { device: "auto", stereoDownmix: false, volumeBoost: false },
      }),
    },
  };
});

vi.mock("@bindings/account", () => ({
  Service: { Status: async () => ({ signedIn: true, sessionEnded: false }) },
}));

const originalMatchMedia = window.matchMedia;

// jsdom has no layout: say whether the window is narrow.
function width(compact: boolean) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: compact && query === compactQuery,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

beforeEach(() => {
  unbound.state.calls = [];
  onIOS();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const linkNames = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("the iOS shell", () => {
  it("puts the sections and Search in a floating tab bar at compact width", async () => {
    width(true);
    await renderApp("/settings?section=about");

    const tabs = screen.getByRole("navigation", { name: "Main" });
    expect(tabs).toHaveAttribute("data-slot", "tab-bar");
    // VoiceOver order: the tabs, then Search.
    expect(linkNames(tabs)).toEqual(["Home", "Movies", "Shows", "Anime", "Library", "Search"]);
    const bar = document.querySelector<HTMLElement>('[data-slot="top-bar"]')!;
    expect(within(bar).queryByRole("link", { name: "Search" })).not.toBeInTheDocument();
  });

  it("keeps the section it came from on a page outside them", async () => {
    width(true);
    const user = userEvent.setup();
    await renderApp("/library");
    const tabs = screen.getByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(within(tabs).getByRole("link", { name: "Library" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );

    await user.click(await screen.findByRole("button", { name: /Profile: Kevin/ }));
    // On the iPhone the profile menu is a bottom sheet (#134): Settings is a link.
    await user.click(await screen.findByRole("link", { name: "Settings" }));

    await screen.findByRole("navigation", { name: "Settings panes" });
    expect(within(tabs).getByRole("link", { name: "Library" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("scrolls to the top when the current tab is tapped again", async () => {
    width(true);
    const user = userEvent.setup();
    await renderApp("/library");
    const pane = document.getElementById("content")!;
    const scrollTo = vi.fn<(options?: ScrollToOptions) => void>();
    Object.defineProperty(pane, "scrollTo", { value: scrollTo, configurable: true });

    const tabs = screen.getByRole("navigation", { name: "Main" });
    await user.click(within(tabs).getByRole("link", { name: "Library" }));

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it("goes back to the section's root from a page it kept the selection on", async () => {
    width(true);
    const user = userEvent.setup();
    const { router } = await renderApp("/library");
    await user.click(await screen.findByRole("button", { name: /Profile: Kevin/ }));
    await user.click(await screen.findByRole("link", { name: "Settings" }));
    await screen.findByRole("navigation", { name: "Settings panes" });

    const tabs = screen.getByRole("navigation", { name: "Main" });
    await user.click(within(tabs).getByRole("link", { name: "Library" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
  });

  it("hides the bar while something asks it to", async () => {
    width(true);
    await renderApp("/settings?section=about");
    const tabs = screen.getByRole("navigation", { name: "Main" });
    expect(tabs).not.toHaveAttribute("inert");

    let release: (() => void) | undefined;
    act(() => {
      release = hideTabBar();
    });
    expect(tabs).toHaveAttribute("inert");
    act(() => release?.());
    expect(tabs).not.toHaveAttribute("inert");
  });

  it("floats the sections at the bottom centre at regular width", async () => {
    width(false);
    await renderApp("/settings?section=about");

    // The iPad's sections float at the bottom centre (#138), not in the top
    // bar, and the bar never shrinks.
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav).toHaveAttribute("data-slot", "tab-bar");
    expect(nav).toHaveAttribute("data-centred");
    expect(linkNames(nav)).toEqual(["Home", "Movies", "Shows", "Anime", "Library", "Search"]);
    const bar = document.querySelector<HTMLElement>('[data-slot="top-bar"]')!;
    expect(within(bar).queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });

  it("has no command palette", async () => {
    width(false);
    const user = userEvent.setup();
    await renderApp("/settings?section=about");

    await user.keyboard("{Control>}k{/Control}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Watch parties are in the iOS app too (ADR-0063): signed in, and never for a
  // kids profile.
  it("offers a watch party in the profile menu", async () => {
    width(false);
    const user = userEvent.setup();
    await renderApp("/settings?section=about");

    await user.click(await screen.findByRole("button", { name: /Profile: Kevin/ }));

    expect(await screen.findByRole("menuitem", { name: "Watch party" })).toBeInTheDocument();
  });
});

const tabBar = () => document.querySelector('[data-slot="tab-bar"]');

describe("menus on the iPhone (#134)", () => {
  it("opens the profile menu as a bottom sheet, with the tab bar hidden meanwhile", async () => {
    width(true);
    const user = userEvent.setup();
    await renderApp("/settings?section=about");
    const trigger = await screen.findByRole("button", { name: /Profile: Kevin/ });

    await user.click(trigger);

    const sheet = await screen.findByRole("dialog", { name: "Profile: Kevin" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Settings" })).toBeInTheDocument();
    // Watch parties are in the iOS app too (ADR-0063), as a row of the sheet.
    expect(within(sheet).getByRole("link", { name: "Watch party" })).toBeInTheDocument();
    // The tab bar (#129) stays mounted but hidden: inert and slid away.
    expect(tabBar()).toHaveAttribute("inert");

    // Switch profile is a second page of the same sheet.
    await user.click(within(sheet).getByRole("button", { name: "Switch profile" }));
    expect(within(sheet).getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Manage profiles" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(tabBar()).not.toHaveAttribute("inert");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("Settings on iOS", () => {
  it("has no Plugins pane, and ?section=plugins opens the first", async () => {
    await renderApp("/settings?section=plugins");

    const panes = await screen.findByRole("navigation", { name: "Settings panes" });
    expect(within(panes).queryByRole("link", { name: "Plugins" })).not.toBeInTheDocument();
    expect(within(panes).getByRole("link", { name: "Streaming" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "Account" })).toBeInTheDocument();
  });

  it("leaves updates and the design system out of About", async () => {
    await renderApp("/settings?section=about");

    await screen.findByRole("button", { name: "Licences" });
    expect(screen.queryByText("Updates")).not.toBeInTheDocument();
    expect(screen.queryByText("Design system")).not.toBeInTheDocument();
  });

  // The iOS player applies the picture, sound and HDR settings too (the
  // sheet's tabs are the same there), so the rows are the desktop's minus the
  // ones Go can't do on iOS.
  it("keeps the Playback rows the iOS player applies", async () => {
    await renderApp("/settings?section=playback");

    await screen.findByRole("switch", { name: "Skip intros automatically" });
    for (const name of ["Hardware decoding", "Tone mapping", "Scaling", "Debanding", "Fit"]) {
      expect(screen.getByText(name, { selector: "[id$=-label]" })).toBeInTheDocument();
    }
    for (const name of ["Picture", "Framing", "Sound"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    // The pinch fills the screen, and no key is named to say so.
    expect(screen.getByText(/Pinch the video to fill the screen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fill" })).not.toBeInTheDocument();
  });

  it("leaves the picture controls iOS can't apply out of Playback", async () => {
    await renderApp("/settings?section=playback");

    await screen.findByRole("switch", { name: "Skip intros automatically" });
    for (const name of [
      "Remove black bars",
      "Sharpening",
      "Upscaling",
      "Motion smoothing",
      "Deinterlacing",
      "Output",
      "Volume up to 150 %",
    ]) {
      expect(screen.queryByText(name, { selector: "[id$=-label]" })).toBeNull();
    }
  });

  it("leaves torrents and HDR out of Streaming", async () => {
    await renderApp("/settings?section=streaming");

    await screen.findByText("Maximum resolution");
    expect(screen.queryByRole("switch", { name: "Stream torrents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "HDR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Dolby Vision" })).not.toBeInTheDocument();
  });
});

describe("routes that aren't in the iOS app", () => {
  it("sends /gallery to Home", async () => {
    const { router } = await renderApp("/gallery");

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  // Person pages are back on an iPad at regular width (#138), not on an iPhone.
  it("sends /person/1 to Home on an iPhone", async () => {
    width(true);
    const { router } = await renderApp("/person/1");

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("keeps /person/1 on an iPad at regular width", async () => {
    width(false);
    const { router } = await renderApp("/person/1");

    expect(router.state.location.pathname).toBe("/person/1");
  });
});

// The party page is in the iOS app now (ADR-0063), as is everything it asks for:
// joining with a code, and the party's own state.
describe("the watch party page on iOS", () => {
  it("stays, and asks for a friend's code", async () => {
    width(false);
    const { router } = await renderApp("/party");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Watch party" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/party");
    expect(await screen.findByRole("textbox", { name: "Party code" })).toBeInTheDocument();
  });
});

describe("unbound services", () => {
  it("are never called by the shell or Settings", async () => {
    const { router } = await renderApp("/settings?section=about");
    await screen.findByRole("button", { name: "Licences" });
    for (const section of ["streaming", "playback", "tracking", "privacy"] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await router.navigate({ to: "/settings", search: { section } });
    }
    await router.navigate({ to: "/library" });
    await router.navigate({ to: "/" });

    expect(unbound.state.calls).toEqual([]);
  });
});
