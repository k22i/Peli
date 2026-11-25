import type { QueryClient } from "@tanstack/react-query";
import { createHashHistory, createRouter, type RouterHistory } from "@tanstack/react-router";

import type { Watching } from "@bindings/playback";
import type { Source } from "@bindings/streams";
import type { Stream } from "@/lib/addon-protocol";
import { ErrorScreen } from "@/components/error-screen";
import { trackRoute } from "@/lib/diagnostics";
import { trackNavDirection } from "@/lib/nav-direction";
import type { LivePlay } from "@/lib/livetv";
import type { PlayTarget } from "@/lib/playback";
import type { SubtitleTarget } from "@/lib/subtitles";
import type { TitlePreview } from "@/lib/title";
import { routeTree } from "@/routeTree.gen";

// Hash history: Wails' asset server has no index.html fallback, so a reload
// on a path like /movies would 404.
export function createAppRouter(
  queryClient: QueryClient,
  history: RouterHistory = createHashHistory(),
) {
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultPreload: "intent",
    // TanStack Query owns caching; always let loaders call into it.
    defaultPreloadStaleTime: 0,
    // The shell's content pane scrolls, not the window (see AppShell).
    scrollRestoration: true,
    scrollToTopSelectors: ["#content"],
    // Animates the content pane only (a cross-fade between sections, a scale
    // in or out for deeper pages and back, see lib/nav-direction.ts); index.css
    // keeps the shell still and turns it off for reduced motion.
    defaultViewTransition: true,
    // A page that throws while rendering or loading shows "Something went
    // wrong" with Reload and Go Home, not a blank pane (#127).
    defaultErrorComponent: ErrorScreen,
  });
  // The router lives as long as the app, so the subscription is never undone.
  trackNavDirection(router);
  // The route to come back to after the webview's content process dies.
  trackRoute(router);
  return router;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    // The card a title page was opened from, so it paints before its
    // details load (#45).
    title?: TitlePreview;
    // What the stream picker was opened to play, for its heading (#50).
    play?: PlayTarget;
    // What the player is playing (#60): its heading, the episode under it
    // (#61), the source, to ask for again if its link expires, the addon's
    // stream it came from, to mark in the stream switcher (#68), what to ask
    // subtitle addons (#63), and the film or episode its progress is kept
    // for, with where it resumed, in seconds (#64).
    player?: {
      title: string;
      episode?: string | undefined;
      source?: Source;
      stream?: Stream;
      subtitles?: SubtitleTarget;
      watching?: Watching;
      resumedAt?: number;
      // A live channel (ADR-0066): the live player plays it instead.
      live?: LivePlay;
    };
  }

  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }

  interface StaticDataRouteOption {
    // "none" renders the route without the shell's sidebar, title bar and
    // backgrounds, so the player can show video under a transparent window
    // (ADR-0002). "focus" keeps only the title bar, for screens that come
    // before the app, such as welcome and sign-in.
    chrome?: "none" | "focus";
  }
}
