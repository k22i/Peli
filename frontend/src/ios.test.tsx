import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Profile } from "@bindings/store";
import { compactQuery } from "@/lib/shell-mode";
import { hideTabBar } from "@/lib/tab-bar";
import { onIOS } from "@/test/ios";
import { renderApp } from "@/test/render-app";

// The iOS app (ADR-0055) has no updates, party, plugins or torrent services:
// a call to one rejects with "unknown bound method id". These stand-ins fail
// the same way and count the calls, so a screen that makes one shows here.
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
vi.mock("@bindings/party", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...unbound.notBound("party"),
}));
vi.mock("@bindings/plugins", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...unbound.notBound("plugins"),
}));
vi.mock("@bindings/torrent", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...unbound.notBound("torrent"),
}));

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
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));

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
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
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

    let release = () => {};
    act(() => {
      release = hideTabBar();
    });
    expect(tabs).toHaveAttribute("inert");
    act(() => release());
    expect(tabs).not.toHaveAttribute("inert");
  });

  it("keeps the top bar's sections at regular width", async () => {
    width(false);
    await renderApp("/settings?section=about");

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav).not.toHaveAttribute("data-slot", "tab-bar");
    expect(linkNames(nav)).toEqual([
      "Home",
      "Movies",
      "Shows",
      "Anime",
      "Library",
      expect.stringContaining("Search"),
    ]);
  });

  it("has no command palette", async () => {
    width(false);
    const user = userEvent.setup();
    await renderApp("/settings?section=about");

    await user.keyboard("{Control>}k{/Control}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers no watch party in the profile menu", async () => {
    width(false);
    const user = userEvent.setup();
    await renderApp("/settings?section=about");

    await user.click(await screen.findByRole("button", { name: /Profile: Kevin/ }));

    await screen.findByRole("menuitem", { name: "Settings" });
    expect(screen.queryByRole("menuitem", { name: "Watch party" })).not.toBeInTheDocument();
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

  it("leaves mpv's picture, sound and HDR controls out of Playback", async () => {
    await renderApp("/settings?section=playback");

    await screen.findByRole("switch", { name: "Skip intros automatically" });
    for (const name of ["Hardware decoding", "Tone mapping", "Picture", "Fit", "Output"]) {
      expect(screen.queryByText(name, { selector: "label, h3, [id$=-label]" })).toBeNull();
    }
    expect(screen.queryByRole("switch", { name: "Hardware decoding" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sound" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Framing" })).not.toBeInTheDocument();
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
  it.each(["/party", "/person/1", "/gallery"])("sends %s to Home", async (path) => {
    const { router } = await renderApp(path);

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
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
