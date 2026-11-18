import { isCancelledError, type QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";

import { Service as Diagnostics } from "@bindings/diagnostics";
import { isIOS } from "@/lib/platform";

// What lets Peli on a phone show why it broke (#127): errors go to Go's log
// (Settings › About › Diagnostics shares it), and the route is saved so the
// page comes back where it was after iOS kills WebKit's content process.

export type ErrorKind = "js" | "rejection" | "render";

// At most this many reports a minute: a render loop or a failing interval
// would otherwise flood the log.
export const reportsPerMinute = 20;

let sent: number[] = [];

// For tests: forget the reports already counted.
export function resetReports() {
  sent = [];
}

// Errors that aren't faults: a fetch aborted because the page moved on, a
// query TanStack cancelled.
export function ignorable(error: unknown): boolean {
  if (isCancelledError(error)) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

function describe(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack ?? "" };
  }
  try {
    return { message: typeof error === "string" ? error : JSON.stringify(error), stack: "" };
  } catch {
    return { message: String(error), stack: "" };
  }
}

// Sends the error to Go's log, unless it is ignorable or over the limit.
// Returns whether it was sent.
export function reportError(kind: ErrorKind, error: unknown, now = Date.now()): boolean {
  if (ignorable(error)) return false;
  sent = sent.filter((at) => now - at < 60_000);
  if (sent.length >= reportsPerMinute) return false;
  sent.push(now);
  const { message, stack } = describe(error);
  // Reporting must never throw or reject in turn.
  try {
    Diagnostics.Report(kind, message, stack).catch(() => {});
  } catch {
    // No runtime (a test, a page outside the app).
  }
  return true;
}

// The window's uncaught errors and unhandled rejections go to reportError.
// Returns the undo.
const onError = (event: ErrorEvent) => reportError("js", event.error ?? event.message);
const onRejection = (event: PromiseRejectionEvent) => reportError("rejection", event.reason);

export function installErrorHandlers(target: Window = window): () => void {
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

// --- The route to come back to ------------------------------------------------

// sessionStorage survives a reload of the same webview, a content-process
// kill included; Go keeps a copy (Diagnostics.SetRoute) for when it doesn't.
export const routeKey = "peli.route";

// The query parameter the native shell adds when it reloads the page after
// the content process died (internal/diagnostics/recovery.go).
export const recoveredParam = "peli-recovered";

// Where to come back to from location. Not the player, which has nothing to
// play after a reload: the title it was playing, or Home.
export type RouteLocation = {
  pathname: string;
  href: string;
  state: { player?: { watching?: { contentType?: string; contentId?: string } | undefined } };
};

export function restoreTarget(location: RouteLocation): string {
  if (location.pathname === "/player") {
    const watching = location.state.player?.watching;
    return watching?.contentType && watching.contentId
      ? `/title/${encodeURIComponent(watching.contentType)}/${encodeURIComponent(watching.contentId)}`
      : "/";
  }
  return location.href;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// Saves the route on every navigation the router resolves. On iOS Go keeps
// a copy too.
export function trackRoute(router: AnyRouter) {
  return router.subscribe("onResolved", () => {
    const target = restoreTarget(router.state.location);
    try {
      storage()?.setItem(routeKey, target);
    } catch {
      // Full or blocked: Go's copy is the fallback.
    }
    if (isIOS()) {
      try {
        Diagnostics.SetRoute(target).catch(() => {});
      } catch {
        // No runtime.
      }
    }
  });
}

export type Recovery = "reload" | "home" | null;

// Runs before the first render. When the native shell reloaded the page
// after a content-process kill, the marker is taken off the address and the
// hash is set to the route to come back to: the saved one ("reload"), or
// Home ("home", the page died twice in a row; the caller shows a toast).
export function restoreRoute(win: Window = window): Recovery {
  const params = new URLSearchParams(win.location.search);
  const marker = params.get(recoveredParam);
  if (marker === null) return null;
  params.delete(recoveredParam);
  const search = params.toString();
  let hash = win.location.hash.replace(/^#/, "") || "/";
  if (marker === "reload") {
    let saved: string | null = null;
    try {
      saved = storage()?.getItem(routeKey) ?? null;
    } catch {
      saved = null;
    }
    hash = saved || hash;
    // The address's own hash may still be the player's.
    if (hash.startsWith("/player")) hash = "/";
  } else {
    hash = "/";
  }
  win.history.replaceState(
    win.history.state,
    "",
    `${win.location.pathname}${search ? `?${search}` : ""}#${hash}`,
  );
  return marker === "reload" ? "reload" : marker === "home" ? "home" : null;
}

// --- Memory warnings ---------------------------------------------------------

// The event Go emits when iOS says memory is low.
export const memoryWarningEvent = "diagnostics:memory-warning";

// Drops what isn't on screen: the queries no component uses. They come back
// from the network (or the persisted cache) when they are needed again.
export function trimCaches(queryClient: QueryClient): number {
  const cache = queryClient.getQueryCache();
  const inactive = cache.findAll({ type: "inactive" });
  for (const query of inactive) cache.remove(query);
  return inactive.length;
}

// WebKit's memory cache, decoded images with it (#128). On an iPhone the
// content process was killed for memory twice in a minute while a Movies grid
// scrolled, with no memory warning first: WebKit keeps every image it has
// shown. Dropping the cache lets go of the images no longer on screen (the
// ones shown stay in use); they come back from the disk cache. iOS only:
// Go does nothing elsewhere.
export function trimWebCache() {
  if (!isIOS()) return;
  try {
    Diagnostics.TrimWebCache().catch(() => {});
  } catch {
    // No runtime.
  }
}

// On iOS, drops WebKit's memory cache whenever the page changes: the last
// page's images go. Returns the undo.
export function trimWebCacheOnNavigation(router: AnyRouter): () => void {
  if (!isIOS()) return () => {};
  let last = router.state.location.pathname;
  return router.subscribe("onResolved", () => {
    const path = router.state.location.pathname;
    if (path === last) return;
    last = path;
    trimWebCache();
  });
}

// Trims the caches whenever iOS warns. Returns the undo.
export function onMemoryWarning(queryClient: QueryClient): () => void {
  return Events.On(memoryWarningEvent, () => {
    trimCaches(queryClient);
  });
}
