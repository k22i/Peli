import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { sections } from "@/sections";

export type RouterContext = {
  queryClient: QueryClient;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

const navLink =
  "text-muted-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground";

// Bare layout until the app shell (#12) lands.
function RootLayout() {
  return (
    <div className="relative isolate flex min-h-svh flex-col">
      <nav aria-label="Main" className="flex gap-1 px-4 pt-11 pb-4">
        {sections.map((section) => (
          <Button
            key={section.to}
            variant="ghost"
            className={navLink}
            render={<Link to={section.to} activeOptions={{ exact: true }} />}
          >
            {section.label}
          </Button>
        ))}
        <Button variant="ghost" className={`ml-auto ${navLink}`} render={<Link to="/settings" />}>
          Settings
        </Button>
      </nav>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
