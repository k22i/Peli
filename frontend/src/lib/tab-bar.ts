import { useSyncExternalStore } from "react";

import { sections, type Section } from "@/sections";

// The compact shell's tab bar (#129): a floating capsule of sections with
// Search as a round button beside it. On iOS 26 it is native Liquid Glass
// (internal/shell, driven by useNativeTabBar); before that, and in tests,
// TabBar draws a CSS look-alike with the same geometry. Both read the rules
// here.

// Search is the round button beside the capsule; the capsule holds the rest.
export const searchSection = sections.find((section) => section.to === "/search")!;
export const tabSections: readonly Section[] = sections.filter(
  (section) => section !== searchSection,
);

// The section a page belongs to: its own (a section's root or a page under
// its path, such as /library?view=…), or for a page outside every section
// (a title, a folder, a person, Settings) the one the user came from, as an
// Apple TV tab keeps its selection on a detail page.
export function sectionOf(pathname: string, last: Section | undefined): Section | undefined {
  const own = sections.find(
    (section) =>
      pathname === section.to || (section.to !== "/" && pathname.startsWith(`${section.to}/`)),
  );
  return own ?? last;
}

// Scrolling the content pane minimises the capsule after 48 pt down and
// brings it back after 24 pt up, measured from where the direction last
// changed, as UITabBarController's tabBarMinimizeBehavior = .onScrollDown.
export const minimiseAfter = 48;
export const expandAfter = 24;

export type ScrollTrack = {
  minimized: boolean;
  // Where the current direction started, and the last position seen.
  anchor: number;
  last: number;
  down: boolean;
};

export const restingScroll: ScrollTrack = { minimized: false, anchor: 0, last: 0, down: true };

export function nextScroll(track: ScrollTrack, top: number): ScrollTrack {
  if (top <= 0) return { ...restingScroll, last: Math.max(top, 0) };
  if (top === track.last) return track;
  const down = top > track.last;
  const anchor = down === track.down ? track.anchor : track.last;
  const travelled = Math.abs(top - anchor);
  let minimized = track.minimized;
  if (down && travelled >= minimiseAfter) minimized = true;
  if (!down && travelled >= expandAfter) minimized = false;
  return { minimized, anchor, last: top, down };
}

// A tap on the minimised capsule: back to full size, and it takes another
// 48 pt down from here to minimise again.
export function expandedAt(track: ScrollTrack): ScrollTrack {
  return { ...track, minimized: false, anchor: track.last, down: true };
}

// Hiding the bar on request: a full-screen sheet (#134), the keyboard, or
// anything else that covers the bottom edge calls hideTabBar and calls what
// it returns when done. Each request counts on its own, so two sheets, or a
// sheet and the keyboard, never show the bar early. The route rules (the
// player, the focus screens, regular width) are the shell's and stay out of
// this.
let requests = 0;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function hideTabBar(): () => void {
  requests += 1;
  changed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    requests -= 1;
    changed();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Whether anything has asked the bar to hide.
export function useTabBarHideRequested(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => requests > 0,
    () => false,
  );
}

// The native bar: whether this device has one (iOS 26 and later), learnt
// once at start from TabBarHeight. Until then, and off iOS, it hasn't.
export const nativeTabBar = { available: false };
