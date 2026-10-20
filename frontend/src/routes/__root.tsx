import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/shell/app-shell";
import { needsPicker, profilesQuery, useSessionEndedRedirect } from "@/lib/account";
import { accountQuery } from "@/lib/profile";

export type RouterContext = {
  queryClient: QueryClient;
};

// Screens that come before there is a profile in use.
const beforeProfile = new Set(["/welcome", "/sign-in", "/qr-sign-in", "/profiles"]);

export const Route = createRootRouteWithContext<RouterContext>()({
  // First run: no profiles yet, so start at the welcome screen (#20). If the
  // store can't answer, carry on into the app rather than block it.
  beforeLoad: async ({ context, location, cause }) => {
    if (beforeProfile.has(location.pathname)) return;
    const profiles = await context.queryClient.ensureQueryData(profilesQuery).catch(() => null);
    if (profiles?.length === 0) throw redirect({ to: "/welcome", replace: true });
    // The session ended while the app was closed (#22): offer to sign in
    // again, once per launch. "Not now" carries on with the data kept here.
    if (cause !== "enter") return;
    const account = await context.queryClient.ensureQueryData(accountQuery).catch(() => null);
    if (account?.sessionEnded) {
      throw redirect({ to: "/sign-in", search: { reason: "session-ended" }, replace: true });
    }
    // More than one profile: ask who's watching, with the last one used
    // first in line (#24).
    if (needsPicker(profiles)) throw redirect({ to: "/profiles", replace: true });
  },
  component: RootLayout,
});

function RootLayout() {
  useSessionEndedRedirect();
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
