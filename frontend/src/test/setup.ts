import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vite-plus/test";

import { resetAnimeAnswers } from "@/lib/anime";

import { animeIds } from "./anime";
import { ios } from "./ios";

// Which IMDb ids are anime (#109, asked a page at a time since #128): none,
// unless a test adds them to animeIds (test/anime.ts). No
// anime entry stands for one IMDb title (PosterTitles).
vi.mock("@bindings/animelist", () => ({
  Service: {
    LeaveOut: vi.fn<(ids: string[]) => Promise<{ anime: boolean[]; ready: boolean }>>((ids) =>
      Promise.resolve({ anime: ids.map((id) => animeIds.has(id)), ready: true }),
    ),
    PosterTitles: vi.fn<
      (ids: string[]) => Promise<{ titles: { imdb: string; type: string }[]; ready: boolean }>
    >((ids) => Promise.resolve({ titles: ids.map(() => ({ imdb: "", type: "" })), ready: true })),
  },
}));

// Tracking (#71): nothing connected, unless a test says otherwise. Every
// title's menu and page asks.
vi.mock("@bindings/tracking", () => ({
  Service: {
    Status: vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({
        simklAvailable: true,
        anilistAvailable: true,
        kids: false,
        simkl: null,
        anilist: null,
      }),
    ),
    ImportSoon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    TitleStatus: vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ status: "none", rating: 0, services: [], queued: false }),
    ),
    Watchlist: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
  },
}));

// Diagnostics (#127): reports and the saved route go nowhere; no logs kept,
// no crash, not a dev build, unless a test says otherwise.
vi.mock("@bindings/diagnostics", () => ({
  Service: {
    Report: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    SetRoute: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    ShareLogs: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    LastCrash: vi.fn<() => Promise<unknown>>(() => Promise.resolve(null)),
    Info: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ dev: false, logs: false })),
    DevCrash: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    DevMark: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    TrimWebCache: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  },
}));

// The Home Screen icon menu (#141): nothing set, nothing waiting.
vi.mock("@bindings/quickactions", () => ({
  Service: {
    SetItems: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    TakePending: vi.fn<() => Promise<unknown>>(() => Promise.resolve(null)),
  },
}));

// The iOS app (ADR-0055): off, unless a test turns it on with `onIOS()` from
// ./ios (reset after each test). feature() and the shell ask these.
vi.mock("@/lib/platform", async (importOriginal) => {
  const original = await importOriginal<{
    isTouch: () => boolean;
    currentPlatform: () => string;
  }>();
  const state = await import("./ios");
  return {
    ...original,
    isIOS: () => state.ios.on,
    isTouch: () => state.ios.on || original.isTouch(),
    currentPlatform: () => (state.ios.on ? "ios" : original.currentPlatform()),
  };
});

// Updates (#83): off, as in a development build, unless a test says
// otherwise. The shell asks, for the "update ready" pill.
vi.mock("@bindings/updates", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Status: vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ state: "off", reason: "development", current: "0.0.0-dev" }),
    ),
    Check: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ state: "checking" })),
    Restart: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  },
}));

// Watch parties (ADR-0051): not in one, unless a test says otherwise. The
// shell, the player and the picker all ask.
vi.mock("@bindings/party", () => ({
  Service: {
    State: vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ unavailable: "", busy: false, party: null }),
    ),
    Chat: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ messages: [], unread: 0 })),
    Watch: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    StartAt: vi.fn<() => Promise<number>>(() => Promise.resolve(-1)),
    SetChatOpen: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    Create: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    Join: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    Leave: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    End: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    Preview: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ error: "party_not_found" })),
    CatchUp: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    SetHostOnly: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    SetSharing: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    SwitchTo: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    RemoveMember: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    SendMessage: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    RetryMessage: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  },
}));

// jsdom does not implement scrolling; the router's scroll restoration and
// Base UI's menus call it.
window.scrollTo = () => {};
Object.defineProperty(Element.prototype, "scrollTo", { value: () => {}, configurable: true });

// Globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
  ios.on = false;
  window.localStorage.clear();
  // The anime answers are kept for the session (lib/anime.ts).
  resetAnimeAnswers();
  animeIds.clear();
});

// jsdom has no matchMedia: report no preference (light, motion allowed).
// Tests that need a setting stub their own.
window.matchMedia ??= (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

// jsdom has no layout, so every element is 0 px and a virtualizer mounts
// nothing. Give rows and the page's scroll container a laptop's viewport.
const viewport = { width: 1280, height: 800 };
const sized = (element: Element) =>
  ["row-scroller", "poster-grid"].includes(element.getAttribute("data-slot") ?? "") ||
  element.id === "content";
for (const [property, size] of [
  ["clientWidth", viewport.width],
  ["clientHeight", viewport.height],
] as const) {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, property)!;
  Object.defineProperty(Element.prototype, property, {
    configurable: true,
    get(this: Element): unknown {
      return sized(this) ? size : original.get?.call(this);
    },
  });
}
// The shell's #content scrolls (Base UI sets `overflow: scroll`, which jsdom
// doesn't compute into overflowY), so a PosterGrid in a page finds it.
const computedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element, pseudo) => {
  const style = computedStyle(element, pseudo);
  if (element.id === "content") {
    Object.defineProperty(style, "overflowY", { value: "auto" });
  }
  return style;
};
