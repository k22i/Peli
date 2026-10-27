import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, redirect, useLocation } from "@tanstack/react-router";

import { PinGate } from "@/components/account/pin-dialog";
import { AppShell } from "@/components/shell/app-shell";
import {
  needsPicker,
  profilesQuery,
  useSessionEndedRedirect,
  useUnlockedProfiles,
} from "@/lib/account";
import { accountQuery, useCurrentProfile } from "@/lib/profile";
import { useConnectionEvents, useSyncEvents, useSyncProfile } from "@/lib/sync";

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
  useSyncEvents();
  useConnectionEvents();
  const location = useLocation();
  // The launch gate only applies once a profile is in use, so it skips the
  // screens that come before one — and doesn't ask the store for the current
  // profile (which makes a Guest on first run) while they're showing.
  if (beforeProfile.has(location.pathname)) {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  }
  return <ProfileGate />;
}

// A PIN-locked profile can't be used until it's unlocked this run (#25).
function ProfileGate() {
  const current = useCurrentProfile();
  const unlocked = useUnlockedProfiles();
  useSyncProfile(current.id);

  if (current.pinEnabled && current.id !== undefined && !unlocked.includes(current.id)) {
    return (
      <AppShell>
        <PinGate profile={current} />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
