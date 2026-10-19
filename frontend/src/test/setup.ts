import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vite-plus/test";

// jsdom does not implement scrolling; the router's scroll restoration calls it.
window.scrollTo = () => {};

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
