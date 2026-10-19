import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/shell/app-shell";
import { profilesQuery } from "@/lib/account";

export type RouterContext = {
  queryClient: QueryClient;
};

// Screens that come before there is a profile.
const beforeProfile = new Set(["/welcome", "/sign-in"]);

export const Route = createRootRouteWithContext<RouterContext>()({
  // First run: no profiles yet, so start at the welcome screen (#20). If the
  // store can't answer, carry on into the app rather than block it.
  beforeLoad: async ({ context, location }) => {
    if (beforeProfile.has(location.pathname)) return;
    const profiles = await context.queryClient.ensureQueryData(profilesQuery).catch(() => null);
    if (profiles?.length === 0) throw redirect({ to: "/welcome", replace: true });
  },
  component: RootLayout,
});

function RootLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
