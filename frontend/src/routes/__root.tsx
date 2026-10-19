import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";

import { sections } from "@/sections";

export type RouterContext = {
  queryClient: QueryClient;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

// Bare layout until the app shell (#12) lands.
function RootLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <nav aria-label="Main" className="flex gap-4 px-6 pt-12 pb-4">
        {sections.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            className="text-ink-muted [&.active]:text-ink"
            activeOptions={{ exact: true }}
          >
            {section.label}
          </Link>
        ))}
        <Link to="/settings" className="ml-auto text-ink-muted [&.active]:text-ink">
          Settings
        </Link>
      </nav>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
