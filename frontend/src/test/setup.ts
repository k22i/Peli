import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vite-plus/test";

// Which IMDb ids are anime (#109): none, unless a test says otherwise with
// vi.mocked(AnimeList.IMDbIDs).
vi.mock("@bindings/animelist", () => ({
  Service: {
    IMDbIDs: vi.fn<() => Promise<{ imdb: string[]; ready: boolean }>>(() =>
      Promise.resolve({ imdb: [], ready: true }),
    ),
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
  window.localStorage.clear();
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
