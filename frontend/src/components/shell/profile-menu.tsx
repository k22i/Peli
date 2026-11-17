import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  LogIn,
  LogOut,
  PartyPopper,
  Puzzle,
  Settings,
  UserCog,
  Users,
} from "lucide-react";
import { useState } from "react";

import { parentSteps, pinSteps, usePinSteps } from "@/components/account/pin-dialog";
import { ProfileAvatar } from "@/components/account/profile-avatar";
import { SignOutDialog } from "@/components/account/sign-out-dialog";
import { MenuGroupLabel } from "@/components/ui/menu";
import {
  ResponsiveMenu,
  ResponsiveMenuGroup,
  ResponsiveMenuItem,
  ResponsiveMenuLinkItem,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuSeparator,
  ResponsiveMenuShortcut,
  ResponsiveMenuSub,
  useMenuMode,
} from "@/components/ui/responsive-menu";
import { toastManager } from "@/components/ui/toast";
import { profilesQuery, useSwitchProfile } from "@/lib/account";
import { feature } from "@/lib/features";
import { currentPlatform, isTouch } from "@/lib/platform";
import { useCurrentProfile } from "@/lib/profile";

// Everything that isn't a top-level section: profiles, addons, settings.
export function ProfileMenu() {
  const profile = useCurrentProfile();
  const mac = currentPlatform() === "mac";
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  // A kids profile asks for its parent PIN before anything that leaves or
  // changes it (#26).
  const { ask, dialog: parentDialog } = usePinSteps();

  return (
    <>
      <ResponsiveMenu
        label={`Profile: ${profile.name}`}
        header={<ProfileHeading profile={profile} sheet />}
        side="bottom"
        align="end"
        sideOffset={8}
        popupClassName="w-72"
        trigger={{
          "aria-label": `Profile: ${profile.name}`,
          className:
            "group/profile flex items-center gap-1.5 rounded-full p-0.5 pe-2 pointer-coarse:min-h-11 pointer-coarse:ps-2 outline-none transition-colors duration-(--duration-fast) hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-foreground/10",
          children: (
            <>
              <ProfileAvatar profile={profile} className="size-7 text-[0.625rem]" />
              <ChevronDown
                aria-hidden
                className="size-3.5 text-foreground/60 transition-transform duration-(--duration-fast) group-data-popup-open/profile:rotate-180"
              />
            </>
          ),
        }}
      >
        <ResponsiveMenuGroup>
          <ProfileHeading profile={profile} />
          <SwitchProfileMenu currentId={profile.id} />
          {profile.kids ? (
            <ResponsiveMenuItem
              onClick={() => ask(parentSteps(profile), () => void navigate({ to: "/addons" }))}
            >
              <Puzzle />
              Addons
            </ResponsiveMenuItem>
          ) : (
            <ResponsiveMenuLinkItem render={<Link to="/addons" />}>
              <Puzzle />
              Addons
            </ResponsiveMenuLinkItem>
          )}
          {/* Watch parties (ADR-0051) need a Nuvio profile, and kids
              profiles never join one. */}
          {feature("party") && profile.signedIn && !profile.kids && (
            <ResponsiveMenuLinkItem render={<Link to="/party" />}>
              <PartyPopper />
              Watch party
            </ResponsiveMenuLinkItem>
          )}
          {/* The app shell's shortcut. */}
          <ResponsiveMenuLinkItem
            render={<Link to="/settings" />}
            aria-keyshortcuts={mac ? "Meta+Comma" : "Control+Comma"}
          >
            <Settings />
            Settings
            {!isTouch() && <ResponsiveMenuShortcut>{mac ? "⌘," : "Ctrl+,"}</ResponsiveMenuShortcut>}
          </ResponsiveMenuLinkItem>
        </ResponsiveMenuGroup>
        <ResponsiveMenuSeparator />
        {profile.sessionEnded && (
          <ResponsiveMenuLinkItem
            render={<Link to="/sign-in" search={{ reason: "session-ended" }} />}
          >
            <LogIn />
            Sign in again
          </ResponsiveMenuLinkItem>
        )}
        {/* Guests (#23) can sign in later; their profile stays as it is. */}
        {!profile.signedIn && !profile.sessionEnded && (
          <ResponsiveMenuLinkItem render={<Link to="/sign-in" />}>
            <LogIn />
            Sign in to Nuvio
          </ResponsiveMenuLinkItem>
        )}
        {/* After a session ended, signing out still removes the account's
            data. */}
        {(profile.signedIn || profile.sessionEnded) && (
          <ResponsiveMenuItem onClick={() => setSigningOut(true)}>
            <LogOut />
            Sign out
          </ResponsiveMenuItem>
        )}
      </ResponsiveMenu>
      <SignOutDialog open={signingOut} onOpenChange={setSigningOut} />
      {parentDialog}
    </>
  );
}

// The menu's header: the profile's avatar, name and status. A group label
// at the top of the popover; above the rows (`sheet`) on the iPhone.
function ProfileHeading({
  profile,
  sheet = false,
}: {
  profile: Parameters<typeof ProfileAvatar>[0]["profile"] & {
    name: string;
    kids: boolean;
    signedIn: boolean;
    sessionEnded: boolean;
  };
  sheet?: boolean;
}) {
  const mode = useMenuMode();
  const body = (
    <>
      <ProfileAvatar profile={profile} className="size-11 text-sm" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-display text-[1.375rem] leading-none font-normal">
          {profile.name}
        </span>
        <span className="truncate text-small font-normal text-muted-foreground">
          {statusLine(profile)}
        </span>
      </span>
    </>
  );
  if (sheet) return <div className="flex items-center gap-3 border-b px-5 pb-3">{body}</div>;
  if (mode === "sheet") return null;
  return (
    <>
      <MenuGroupLabel className="flex items-center gap-3 px-2 pt-2 pb-3 text-body tracking-normal text-foreground normal-case">
        {body}
      </MenuGroupLabel>
      <ResponsiveMenuSeparator />
    </>
  );
}

// The header's second line: whose profile it is and how it syncs.
function statusLine(profile: { kids: boolean; signedIn: boolean; sessionEnded: boolean }): string {
  if (profile.kids) return "Kids profile";
  if (profile.signedIn) return "Signed in to Nuvio";
  if (profile.sessionEnded) return "Session ended";
  return "Not signed in";
}

// Every profile on this device, the current one checked (#24). Picking one
// switches to it in place: what's on screen follows the new profile.
function SwitchProfileMenu({ currentId }: { currentId: number | undefined }) {
  const profiles = useQuery(profilesQuery);
  const switchProfile = useSwitchProfile();
  const current = useCurrentProfile();
  const { ask, dialog } = usePinSteps();

  const pick = (id: unknown) => {
    const profile = profiles.data?.find((p) => p.id === id);
    if (!profile || profile.id === currentId) return;
    // A locked profile asks for its PIN before switching (#25), and a kids
    // profile for its parent PIN to be left (#26).
    ask(pinSteps(current, profile, "switch"), () =>
      switchProfile.mutate(profile, {
        onError: () => {
          toastManager.add({ type: "error", title: `Couldn’t switch to ${profile.name}` });
        },
      }),
    );
  };

  return (
    <>
      <ResponsiveMenuSub
        title="Switch profile"
        popupClassName="w-56"
        label={
          <>
            <Users />
            Switch profile
          </>
        }
      >
        <ResponsiveMenuRadioGroup value={currentId ?? null} onValueChange={pick}>
          {profiles.data?.map((p) => (
            <ResponsiveMenuRadioItem key={p.id} value={p.id}>
              <span className="flex min-w-0 items-center gap-2">
                <ProfileAvatar profile={p} className="size-5 text-[0.5625rem]" />
                <span className="truncate">{p.name}</span>
              </span>
            </ResponsiveMenuRadioItem>
          ))}
        </ResponsiveMenuRadioGroup>
        <ResponsiveMenuSeparator />
        <ResponsiveMenuLinkItem render={<Link to="/profiles" search={{ manage: true }} />}>
          <UserCog />
          Manage profiles
        </ResponsiveMenuLinkItem>
      </ResponsiveMenuSub>
      {dialog}
    </>
  );
}
