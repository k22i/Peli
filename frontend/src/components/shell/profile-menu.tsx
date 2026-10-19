import { Link } from "@tanstack/react-router";
import { LogOut, Puzzle, Settings, Users } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { initials, useCurrentProfile } from "@/lib/profile";

// Everything that isn't a top-level section: profiles, addons, settings.
export function ProfileMenu() {
  const profile = useCurrentProfile();

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Profile: ${profile.name}`}
        className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-start text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent"
      >
        <Avatar className="size-7 bg-sidebar-primary text-sidebar-primary-foreground">
          <AvatarFallback className="bg-transparent">{initials(profile.name)}</AvatarFallback>
        </Avatar>
        <span className="sr-only truncate font-medium md:not-sr-only">{profile.name}</span>
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="w-56">
        <MenuGroup>
          <MenuGroupLabel>{profile.name}</MenuGroupLabel>
          {/* Enabled by the profile picker (#24). */}
          <MenuItem disabled>
            <Users />
            Switch profile
          </MenuItem>
          <MenuLinkItem render={<Link to="/addons" />}>
            <Puzzle />
            Addons
          </MenuLinkItem>
          <MenuLinkItem render={<Link to="/settings" />}>
            <Settings />
            Settings
          </MenuLinkItem>
        </MenuGroup>
        <MenuSeparator />
        {/* Guests (#23) have no account to sign out of; Nuvio sign-in is #20. */}
        <MenuItem disabled={!profile.signedIn}>
          <LogOut />
          Sign out
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
