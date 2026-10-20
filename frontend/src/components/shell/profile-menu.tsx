import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LogIn, LogOut, Puzzle, Settings, UserCog, Users } from "lucide-react";
import { useState } from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import { SignOutDialog } from "@/components/account/sign-out-dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import { toastManager } from "@/components/ui/toast";
import { profilesQuery, useSwitchProfile } from "@/lib/account";
import { currentPlatform } from "@/lib/platform";
import { useCurrentProfile } from "@/lib/profile";

// Everything that isn't a top-level section: profiles, addons, settings.
export function ProfileMenu() {
  const profile = useCurrentProfile();
  const mac = currentPlatform() === "mac";
  const [signingOut, setSigningOut] = useState(false);

  return (
    <>
      <Menu>
        <MenuTrigger
          aria-label={`Profile: ${profile.name}`}
          className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-start text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent"
        >
          <ProfileAvatar profile={profile} className="size-7" />
          <span className="sr-only truncate font-medium md:not-sr-only">{profile.name}</span>
        </MenuTrigger>
        <MenuPopup side="top" align="start" className="w-56">
          <MenuGroup>
            <MenuGroupLabel>{profile.name}</MenuGroupLabel>
            <SwitchProfileMenu currentId={profile.id} />
            <MenuLinkItem render={<Link to="/addons" />}>
              <Puzzle />
              Addons
            </MenuLinkItem>
            {/* The app shell's shortcut. */}
            <MenuLinkItem
              render={<Link to="/settings" />}
              aria-keyshortcuts={mac ? "Meta+Comma" : "Control+Comma"}
            >
              <Settings />
              Settings
              <MenuShortcut aria-hidden>{mac ? "⌘," : "Ctrl+,"}</MenuShortcut>
            </MenuLinkItem>
          </MenuGroup>
          <MenuSeparator />
          {profile.sessionEnded && (
            <MenuLinkItem render={<Link to="/sign-in" search={{ reason: "session-ended" }} />}>
              <LogIn />
              Sign in again
            </MenuLinkItem>
          )}
          {/* Guests (#23) can sign in later; their profile stays as it is. */}
          {!profile.signedIn && !profile.sessionEnded && (
            <MenuLinkItem render={<Link to="/sign-in" />}>
              <LogIn />
              Sign in to Nuvio
            </MenuLinkItem>
          )}
          {/* After a session ended, signing out still removes the account's
            data. */}
          {(profile.signedIn || profile.sessionEnded) && (
            <MenuItem onClick={() => setSigningOut(true)}>
              <LogOut />
              Sign out
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
      <SignOutDialog open={signingOut} onOpenChange={setSigningOut} />
    </>
  );
}

// Every profile on this device, the current one checked (#24). Picking one
// switches to it in place: what's on screen follows the new profile.
function SwitchProfileMenu({ currentId }: { currentId: number | undefined }) {
  const profiles = useQuery(profilesQuery);
  const switchProfile = useSwitchProfile();

  const pick = (id: unknown) => {
    const profile = profiles.data?.find((p) => p.id === id);
    if (!profile || profile.id === currentId) return;
    switchProfile.mutate(profile, {
      onError: () => {
        toastManager.add({ type: "error", title: `Couldn’t switch to ${profile.name}` });
      },
    });
  };

  return (
    <MenuSub>
      <MenuSubTrigger>
        <Users />
        Switch profile
      </MenuSubTrigger>
      <MenuSubPopup className="w-56">
        <MenuRadioGroup value={currentId ?? null} onValueChange={pick}>
          {profiles.data?.map((p) => (
            <MenuRadioItem key={p.id} value={p.id}>
              <span className="flex min-w-0 items-center gap-2">
                <ProfileAvatar profile={p} className="size-5 text-[0.5625rem]" />
                <span className="truncate">{p.name}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLinkItem render={<Link to="/profiles" search={{ manage: true }} />}>
          <UserCog />
          Manage profiles
        </MenuLinkItem>
      </MenuSubPopup>
    </MenuSub>
  );
}
