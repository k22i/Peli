import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  redirect,
  useLocation,
  useRouter,
} from "@tanstack/react-router";

import { PinGate } from "@/components/account/pin-dialog";
import { ErrorScreen } from "@/components/error-screen";
import { AppShell } from "@/components/shell/app-shell";
import { toastManager } from "@/components/ui/toast";
import {
  needsPicker,
  profilesQuery,
  useProfilesChangedEvents,
  useSessionEndedRedirect,
  useUnlockedProfiles,
} from "@/lib/account";
import { useDownloadEvents } from "@/lib/downloads";
import { useLiveTVEvents } from "@/lib/livetv";
import { usePartyEvents, usePartyToasts } from "@/lib/party";
import { isIOS } from "@/lib/platform";
import { accountQuery, beforeProfile, currentProfileQuery, useCurrentProfile } from "@/lib/profile";
import { QuickActionSync, useQuickActionHandler } from "@/lib/quick-actions";
import { deviceSettingsQuery } from "@/lib/settings";
import { useConnectionEvents, useSyncEvents, useSyncProfile } from "@/lib/sync";
import { TitlePrefetchProvider } from "@/lib/title-prefetch";
import { useTrackingEvents, useTrackingProfile } from "@/lib/tracking";
import { useUpdateEvents, useUpdateReadyToast } from "@/lib/updates";

export type RouterContext = {
  queryClient: QueryClient;
};

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
    // first in line (#24), unless this device was told not to ask again.
    if (!needsPicker(profiles)) return;
    const device = await context.queryClient.ensureQueryData(deviceSettingsQuery).catch(() => null);
    if (device?.skipProfilePicker === true) return;
    throw redirect({ to: "/profiles", replace: true });
  },
  component: RootLayout,
  // The shell itself failed: the same screen, with no shell around it.
  errorComponent: ErrorScreen,
});

function RootLayout() {
  useSessionEndedRedirect();
  useProfilesChangedEvents();
  useSyncEvents();
  // Downloads (#85, ADR-0064): the one place the download events are
  // followed, so every screen's list stays live.
  useDownloadEvents();
  // Live TV (ADR-0066), likewise.
  useLiveTVEvents();
  useConnectionEvents();
  useTrackingEvents();
  usePartyEvents(useQueryClient());
  useUpdateEvents();
  const router = useRouter();
  usePartyToasts(
    () => router.state.location.pathname === "/player",
    ({ title, type, action }) =>
      toastManager.add({
        title,
        type,
        ...(action && { actionProps: { children: action.label, onClick: action.run } }),
      }),
  );
  const location = useLocation();
  // Home Screen icon-menu taps (#141): carried out once a profile is in use
  // and unlocked, so the picker and the PIN screen come first.
  // Asked only once a profile is in use: the store makes a Guest on first run
  // when it's asked for the current profile, so the welcome and sign-in
  // screens must not.
  const inUse = !beforeProfile.has(location.pathname);
  const { data: current } = useQuery({ ...currentProfileQuery, enabled: inUse });
  const unlocked = useUnlockedProfiles();
  useQuickActionHandler(
    inUse &&
      current?.id !== undefined &&
      (current.pinEnabled !== true || unlocked.includes(current.id)),
  );
  // Not over a film: it waits until the player closes (#83).
  useUpdateReadyToast(location.pathname === "/player");
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
  useTrackingProfile(current.id);

  if (current.pinEnabled && current.id !== undefined && !unlocked.includes(current.id)) {
    return (
      <AppShell>
        {isIOS() && <QuickActionSync profileId={current.id} locked />}
        <PinGate profile={current} />
      </AppShell>
    );
  }

  return (
    <AppShell>
      {isIOS() && current.id !== undefined && (
        <QuickActionSync profileId={current.id} locked={current.pinEnabled} />
      )}
      <TitlePrefetchProvider profileId={current.id}>
        <Outlet />
      </TitlePrefetchProvider>
    </AppShell>
  );
}
