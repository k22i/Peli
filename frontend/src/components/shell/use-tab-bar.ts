import { Service as Shell } from "@bindings/shell";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { feature } from "@/lib/features";
import { haptic } from "@/lib/haptics";
import { useNavSections } from "@/lib/nav-sections";
import {
  expandedAt,
  nativeTabBar,
  nextScroll,
  restingScroll,
  searchSection,
  sectionOf,
  tabSectionsOf,
  useTabBarHideRequested,
  type ScrollTrack,
} from "@/lib/tab-bar";
import { tabIconName } from "@/lib/tab-icons";
import type { Section } from "@/sections";

export type TabBarModel = {
  // The selected section ("" for none), Search's included.
  active: string;
  // The capsule's tabs, Search's left out: Live TV is among them while the
  // profile has a source.
  items: readonly Section[];
  minimized: boolean;
  // Hidden by a request (a sheet, #134), not by the route: the shell doesn't
  // draw the bar at all on the player and the focus screens.
  hidden: boolean;
  // A tap on a tab, the current one included.
  select: (section: Section) => void;
  // A tap on the minimised capsule.
  expand: () => void;
};

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Scrolls the content pane to the top, smoothly unless motion is reduced: a
// re-tap of the current tab on a section's root (#129) and a tap on the
// status bar (shell:scroll-top, #135).
export function scrollToTop(pane: HTMLElement | null | undefined) {
  pane?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

// The tab bar's behaviour, the same for the native bar and the CSS one:
// which section is current, minimising on scroll, and what a tap does.
// `pane` is #content; `shown` is false where the shell draws no bar (the
// player, the focus screens, regular width).
export function useTabBar(pane: HTMLElement | null, shown: boolean): TabBarModel {
  const pathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  });
  const navigate = useNavigate();
  const own = sectionOf(pathname, undefined);
  const [last, setLast] = useState<Section | undefined>(own);
  if (own && own !== last) setLast(own);
  const section = own ?? last;
  const requested = useTabBarHideRequested();
  // A new array only when the nav's, so the native bar's push stays put.
  const navSections = useNavSections();
  const items = useMemo(() => tabSectionsOf(navSections), [navSections]);

  const track = useRef<ScrollTrack>(restingScroll);
  const [minimized, setMinimized] = useState(false);
  // A new page starts with the bar full size.
  const [page, setPage] = useState(pathname);
  if (page !== pathname) {
    setPage(pathname);
    setMinimized(false);
  }

  useEffect(() => {
    if (!pane || !shown) return undefined;
    // Measured from where this page was when it opened: `page` is a
    // dependency so a new page starts the count again.
    track.current = { ...restingScroll, last: pane.scrollTop };
    let frame = 0;
    const update = () => {
      frame = 0;
      track.current = nextScroll(track.current, pane.scrollTop);
      setMinimized(track.current.minimized);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      pane.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above
  }, [pane, shown, page]);

  const expand = useCallback(() => {
    track.current = expandedAt(track.current);
    setMinimized(false);
  }, []);

  // Re-tapping the current tab goes back to the section's root from a page
  // under it, and on the root scrolls to the top, as UIKit's tab bars do.
  const select = useCallback(
    (target: Section) => {
      if (target !== section) haptic("selection");
      if (target !== section || pathname !== target.to) {
        void navigate({ to: target.to });
        return;
      }
      scrollToTop(pane);
      expand();
    },
    [section, pathname, navigate, pane, expand],
  );

  return { active: section?.to ?? "", items, minimized, hidden: requested, select, expand };
}

// Drives the native Liquid Glass bar (internal/shell) from the model: state
// on every change, one push a frame at most, and its taps back as
// navigation. Does nothing without one (feature("nativeTabBar")).
export function useNativeTabBar(model: TabBarModel, shown: boolean) {
  const native = feature("nativeTabBar");
  const { active, minimized, hidden, select, expand } = model;

  useEffect(() => {
    if (!native) return undefined;
    const items = model.items.map((section) => ({
      id: section.to,
      label: section.label,
      icon: tabIconName(section),
    }));
    const frame = requestAnimationFrame(() => {
      Shell.SetTabBar({
        items,
        active,
        hidden: hidden || !shown,
        minimized,
        search: true,
        placement: "bottom",
      }).catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, [native, model.items, active, hidden, shown, minimized]);

  // The capsule's height follows the window (52 pt on an iPhone on its
  // side): --tabs-h feeds --tabs-float, the content pane's bottom inset.
  useEffect(() => {
    if (!native) return undefined;
    const root = document.documentElement;
    let frame = 0;
    const measure = () => {
      frame = 0;
      Shell.TabBarHeight()
        .then((height) => {
          if (height > 0) root.style.setProperty("--tabs-h", `${height}px`);
        })
        .catch(() => {});
    };
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
      root.style.removeProperty("--tabs-h");
    };
  }, [native]);

  // Latest handlers, so the listeners stay put across renders.
  const handlers = useRef({ select, expand, items: model.items });
  useEffect(() => {
    handlers.current = { select, expand, items: model.items };
  });
  useEffect(() => {
    if (!native) return undefined;
    const off = [
      Events.On("shell:tab", (event) => {
        const target = handlers.current.items.find((section) => section.to === event.data.id);
        if (target) handlers.current.select(target);
      }),
      Events.On("shell:search", () => handlers.current.select(searchSection)),
      Events.On("shell:expand", () => handlers.current.expand()),
    ];
    return () => {
      for (const stop of off) stop();
    };
  }, [native]);
}

// Learns once, at start, whether this device has the native bar: iOS 26 and
// later answer TabBarHeight with the capsule's height, everything else 0.
// Bounded, so a slow bridge never holds the first paint back for long.
export async function startNativeTabBar(
  probe: () => Promise<number> = () => Shell.TabBarHeight(),
  wait = 400,
): Promise<boolean> {
  const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(0), wait));
  const height = await Promise.race([probe().catch(() => 0), timeout]);
  nativeTabBar.available = height > 0;
  return nativeTabBar.available;
}
