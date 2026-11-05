import type { AnyRouter } from "@tanstack/react-router";

// Which way a navigation goes (#124), so the content pane can enter the way
// the page was reached (index.css reads it from `<html data-nav>`):
//   forward  opening something deeper: a title, a folder, the stream picker
//   back     going back in history, by the Back button or the browser
//   section  anything else: the sidebar, ⌘1–6, a chip, a Settings pane
// It is worked out from the history index TanStack Router keeps in each
// entry, so every way of navigating is covered, and nothing has to set it.
export type NavDirection = "forward" | "back" | "section";

type Place = { pathname: string; state?: { __TSR_index?: number } } | undefined;

// The pages you go deeper into from a shelf, a card or a button.
const deeper = [/^\/title\//, /^\/folder\//, /^\/streams\//];

const historyIndex = (place: NonNullable<Place>) => {
  const index = place.state?.["__TSR_index"];
  return typeof index === "number" ? index : undefined;
};

export function navDirection(from: Place, to: Place): NavDirection {
  if (!from || !to || from.pathname === to.pathname) return "section";
  const before = historyIndex(from);
  const after = historyIndex(to);
  if (before === undefined || after === undefined || before === after) return "section";
  if (after < before) return "back";
  return deeper.some((page) => page.test(to.pathname)) ? "forward" : "section";
}

// Sets `data-nav` as each navigation starts, before its view transition does.
// It is left in place afterwards: the transition's pseudo-elements are styled
// from it once the page has changed, and the next navigation replaces it.
export function trackNavDirection(router: AnyRouter): () => void {
  return router.subscribe("onBeforeLoad", ({ fromLocation, toLocation }) => {
    document.documentElement.dataset["nav"] = navDirection(fromLocation, toLocation);
  });
}
