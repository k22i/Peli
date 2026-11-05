import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown, LogIn, LogOut, Puzzle, Settings, UserCog, Users } from "lucide-react";
import { useState } from "react";

import { parentSteps, pinSteps, usePinSteps } from "@/components/account/pin-dialog";
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
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  // A kids profile asks for its parent PIN before anything that leaves or
  // changes it (#26).
  const { ask, dialog: parentDialog } = usePinSteps();

  return (
    <>
      <Menu>
        <MenuTrigger
          aria-label={`Profile: ${profile.name}`}
          className="flex w-full items-center gap-3 rounded-xl p-2 text-start text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent max-md:justify-center"
        >
          <ProfileAvatar profile={profile} className="size-8" />
          <span className="sr-only min-w-0 flex-1 truncate font-[550] md:not-sr-only">
            {profile.name}
          </span>
          <ChevronsUpDown
            aria-hidden
            className="hidden size-4 shrink-0 text-muted-foreground md:block"
          />
        </MenuTrigger>
        <MenuPopup side="top" align="start" className="w-64">
          <MenuGroup>
            <MenuGroupLabel className="flex items-center gap-3 py-2 text-sm tracking-normal text-foreground normal-case">
              <ProfileAvatar profile={profile} className="size-10 text-sm" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-semibold">{profile.name}</span>
                <span className="truncate text-meta font-normal text-muted-foreground">
                  {statusLine(profile)}
                </span>
              </span>
            </MenuGroupLabel>
            <MenuSeparator />
            <SwitchProfileMenu currentId={profile.id} />
            {profile.kids ? (
              <MenuItem
                onClick={() => ask(parentSteps(profile), () => void navigate({ to: "/addons" }))}
              >
                <Puzzle />
                Addons
              </MenuItem>
            ) : (
              <MenuLinkItem render={<Link to="/addons" />}>
                <Puzzle />
                Addons
              </MenuLinkItem>
            )}
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
      {parentDialog}
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
      {dialog}
    </>
  );
}
