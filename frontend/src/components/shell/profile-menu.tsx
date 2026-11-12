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
      <Menu>
        <MenuTrigger
          aria-label={`Profile: ${profile.name}`}
          className="group/profile flex items-center gap-1.5 rounded-full p-0.5 pe-2 pointer-coarse:min-h-11 pointer-coarse:ps-2 outline-none transition-colors duration-(--duration-fast) hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-foreground/10"
        >
          <ProfileAvatar profile={profile} className="size-7 text-[0.625rem]" />
          <ChevronDown
            aria-hidden
            className="size-3.5 text-foreground/60 transition-transform duration-(--duration-fast) group-data-popup-open/profile:rotate-180"
          />
        </MenuTrigger>
        <MenuPopup side="bottom" align="end" sideOffset={8} className="w-72">
          <MenuGroup>
            <MenuGroupLabel className="flex items-center gap-3 px-2 pt-2 pb-3 text-body tracking-normal text-foreground normal-case">
              <ProfileAvatar profile={profile} className="size-11 text-sm" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-display text-[1.375rem] leading-none font-normal">
                  {profile.name}
                </span>
                <span className="truncate text-small font-normal text-muted-foreground">
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
            {/* Watch parties (ADR-0051) need a Nuvio profile, and kids
              profiles never join one. */}
            {feature("party") && profile.signedIn && !profile.kids && (
              <MenuLinkItem render={<Link to="/party" />}>
                <PartyPopper />
                Watch party
              </MenuLinkItem>
            )}
            {/* The app shell's shortcut. */}
            <MenuLinkItem
              render={<Link to="/settings" />}
              aria-keyshortcuts={mac ? "Meta+Comma" : "Control+Comma"}
            >
              <Settings />
              Settings
              {!isTouch() && <MenuShortcut aria-hidden>{mac ? "⌘," : "Ctrl+,"}</MenuShortcut>}
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
