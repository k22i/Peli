import type { QueryClient } from "@tanstack/react-query";
import { createHashHistory, createRouter, type RouterHistory } from "@tanstack/react-router";

import { routeTree } from "@/routeTree.gen";

// Hash history: Wails' asset server has no index.html fallback, so a reload
// on a path like /movies would 404.
export function createAppRouter(
  queryClient: QueryClient,
  history: RouterHistory = createHashHistory(),
) {
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultPreload: "intent",
    // TanStack Query owns caching; always let loaders call into it.
    defaultPreloadStaleTime: 0,
    // The shell's content pane scrolls, not the window (see AppShell).
    scrollRestoration: true,
    scrollToTopSelectors: ["#content"],
    // Cross-fades the content pane only; index.css keeps the shell still and
    // turns it off for reduced motion.
    defaultViewTransition: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }

  interface StaticDataRouteOption {
    // "none" renders the route without the shell's sidebar, title bar and
    // backgrounds, so the player can show video under a transparent window
    // (ADR-0002).
    chrome?: "none";
  }
}
