import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { CardShape } from "@/components/media/row";
import { cn } from "@/lib/utils";

// A Row that mounts only once it comes near the viewport, for a page that
// stacks many of them (Home). Each Row is a virtualizer with a dozen cards,
// each with its menu and art: mounting twenty at once made coming back to
// Home slow, though its data is all in the cache. Until it's near, a
// placeholder of the row's height keeps the page's length (and so scroll
// restoration) about right. Once mounted it stays.
//
// Two distances: within `preloadMargin` of the viewport `preload` runs once
// (fetch the row's first posters, lib preloadArtwork), so by the time it's
// within `mountMargin` and mounts, its art is in WebKit's cache and shows
// at once instead of fading in as it scrolls onto the screen.

const mountMargin = 1; // viewports
const preloadMargin = 3;

function scrollRoot(): HTMLElement | null {
  return document.getElementById("content");
}

function within(element: HTMLElement, viewports: number): boolean {
  const root = scrollRoot();
  const view = root?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const height = view.bottom - view.top;
  const box = element.getBoundingClientRect();
  return box.bottom >= view.top - height * viewports && box.top <= view.bottom + height * viewports;
}

export function DeferredRow({
  shape = "poster",
  preload,
  children,
}: {
  // The row's cards, for the placeholder's height.
  shape?: CardShape;
  preload?: (() => void) | undefined;
  children: ReactNode;
}) {
  const placeholder = useRef<HTMLDivElement>(null);
  // jsdom has no IntersectionObserver: mount at once there.
  const [mounted, setMounted] = useState(() => typeof IntersectionObserver === "undefined");
  const preloaded = useRef(false);
  const latestPreload = useRef(preload);
  useEffect(() => {
    latestPreload.current = preload;
  });
  const runPreload = () => {
    if (preloaded.current) return;
    preloaded.current = true;
    latestPreload.current?.();
  };

  // Rows already on screen mount before the first paint, so the page never
  // shows them empty.
  useLayoutEffect(() => {
    const element = placeholder.current;
    if (mounted || !element) return;
    if (within(element, mountMargin)) setMounted(true);
  }, [mounted]);

  useEffect(() => {
    const element = placeholder.current;
    if (mounted || !element) return undefined;
    const root = scrollRoot();
    const observe = (viewports: number, then: () => void) => {
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect();
            then();
          }
        },
        { root, rootMargin: `${viewports * 100}% 0px` },
      );
      observer.observe(element);
      return observer;
    };
    const near = observe(preloadMargin, runPreload);
    const close = observe(mountMargin, () => setMounted(true));
    return () => {
      near.disconnect();
      close.disconnect();
    };
    // runPreload reads refs only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  if (mounted) return children;
  return (
    <div ref={placeholder} aria-hidden className="flex flex-col">
      {/* The heading's line, the scroller's padding, a card and its caption. */}
      <div className="type-row">&nbsp;</div>
      <div className="px-page pt-3 pb-4">
        <div className={cn(shape === "poster" ? "w-poster" : "w-landscape")}>
          <div className={shape === "poster" ? "aspect-[2/3]" : "aspect-video"} />
          <div className="h-14" />
        </div>
      </div>
    </div>
  );
}
