/* eslint-disable no-await-in-loop -- the loop is a sequence of steps, one after the other, on purpose */
import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";

import { Service as Diagnostics } from "@bindings/diagnostics";
import { dropSrcKey } from "@/components/media/artwork";

// The rig's tab loop (#128), for a pelidev build only: Home → Movies →
// Shows → Anime, each grid scrolled three screens, ten times over, the way
// the user broke the app on an iPhone. Every step logs one `dev loop` line
// (Diagnostics.DevMark, which adds a `memory:` line and writes the log out),
// so the shared log shows where memory went and the step a kill cut short.
// It isn't tied to the page that starts it: leaving Settings is the point.

export const loopRoutes = ["/", "/movies", "/shows", "/anime"] as const;

export type LoopOptions = {
  rounds?: number;
  // Screens each grid is scrolled.
  screens?: number;
  // How long a page may take to show a card or a notice.
  timeoutMs?: number;
  // Between scrolls, for the images to come in.
  pauseMs?: number;
  // The drop-src retest (components/media/artwork.tsx dropSrcKey).
  dropSrc?: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What a page is showing: a card's image, or a notice (an error or an empty
// state names itself in an h2).
function pageState(): { images: number; notice: string | undefined } {
  const content = document.getElementById("content");
  const images = content ? content.querySelectorAll("img").length : 0;
  const notice = content?.querySelector("[data-slot=empty] h2")?.textContent ?? undefined;
  return { images, notice };
}

// The images in the page and their decoded size, as WebKit holds them.
function imageStats() {
  let decoded = 0;
  let loaded = 0;
  let failed = 0;
  for (const img of Array.from(document.images)) {
    if (img.complete && img.naturalWidth > 0) {
      loaded++;
      decoded += img.naturalWidth * img.naturalHeight * 4;
    } else if (img.complete) {
      failed++;
    }
  }
  return {
    imgs: document.images.length,
    loaded,
    failed,
    decodedMB: Math.round(decoded / 1e5) / 10,
    widest: Math.max(0, ...Array.from(document.images, (img) => img.naturalWidth)),
  };
}

// The images fetched since the loop started, from Resource Timing: what
// WebKit's caches have taken in (an image off screen is gone from the DOM,
// so the DOM count alone can't say). WebContent's own footprint isn't
// readable from the page or the app.
function fetchedImages() {
  const images = performance
    .getEntriesByType("resource")
    .filter(
      (entry): entry is PerformanceResourceTiming =>
        entry instanceof PerformanceResourceTiming && entry.initiatorType === "img",
    );
  const bytes = images.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0);
  return { fetched: images.length, fetchedMB: Math.round(bytes / 1e5) / 10 };
}

async function waitForContent(timeoutMs: number): Promise<number | undefined> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const { images, notice } = pageState();
    if (images > 0 || notice) return Math.round(performance.now() - start);
    await sleep(100);
  }
  return undefined;
}

function mark(note: string) {
  // The log is the result: a failed mark must not stop the loop.
  return Diagnostics.DevMark(note).catch(() => {});
}

let running = false;

function setDropSrc(on: boolean) {
  try {
    if (on) window.localStorage.setItem(dropSrcKey, "1");
    else window.localStorage.removeItem(dropSrcKey);
  } catch {
    // Blocked storage: the loop runs without the retest.
  }
}

export async function runTabLoop(
  router: AnyRouter,
  queryClient: QueryClient,
  {
    rounds = 10,
    screens = 3,
    timeoutMs = 15_000,
    pauseMs = 800,
    dropSrc = false,
  }: LoopOptions = {},
): Promise<void> {
  if (running) return;
  running = true;
  const started = performance.now();
  performance.clearResourceTimings();
  performance.setResourceTimingBufferSize(20_000);
  setDropSrc(dropSrc);
  try {
    await mark(`start rounds=${rounds} screens=${screens} dropSrc=${dropSrc}`);
    for (let round = 1; round <= rounds; round++) {
      for (const route of loopRoutes) {
        await router.navigate({ to: route });
        const first = await waitForContent(timeoutMs);
        for (let i = 0; i < screens; i++) {
          const content = document.getElementById("content");
          content?.scrollBy({ top: content.clientHeight });
          await sleep(pauseMs);
        }
        await sleep(pauseMs);
        const { notice } = pageState();
        const images = imageStats();
        const fetched = fetchedImages();
        await mark(
          [
            `round=${round}`,
            `route=${route}`,
            `first=${first === undefined ? "timeout" : `${first}ms`}`,
            `notice=${notice ? JSON.stringify(notice) : "-"}`,
            `imgs=${images.imgs}`,
            `loaded=${images.loaded}`,
            `failed=${images.failed}`,
            `decoded=${images.decodedMB}MB`,
            `widest=${images.widest}px`,
            `fetched=${fetched.fetched}`,
            `fetchedMB=${fetched.fetchedMB}`,
            `nodes=${document.getElementsByTagName("*").length}`,
            `queries=${queryClient.getQueryCache().getAll().length}`,
          ].join(" "),
        );
      }
    }
    await mark(`done in ${Math.round((performance.now() - started) / 1000)}s`);
  } finally {
    setDropSrc(false);
    running = false;
  }
}
