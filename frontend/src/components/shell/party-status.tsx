import { Link } from "@tanstack/react-router";
import { Users } from "lucide-react";

import { useParty, usePartyChat } from "@/lib/party";

// A pill beside the profile menu while this device is in a watch party
// (ADR-0051): how many are in it, a dot for unread chat, and a link to the
// party page.
export function PartyStatus() {
  const party = useParty()?.party;
  const unread = usePartyChat().unread;
  if (!party) return null;
  const count = party.members?.length ?? 0;
  return (
    <Link
      to="/party"
      aria-label={`Watch party, ${count} ${count === 1 ? "person" : "people"}${unread > 0 ? `, ${unread} unread` : ""}`}
      className="relative flex h-7 items-center gap-1.5 rounded-full bg-sun/14 px-2.5 text-small font-[590] text-sun-ink outline-none transition-colors hover:bg-sun/22 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      <Users aria-hidden />
      <span aria-hidden className="tnum">
        {count}
      </span>
      <span aria-hidden className="hidden lg:inline">
        Watch party
      </span>
      {unread > 0 && (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-[#ffb547] ring-2 ring-background"
        />
      )}
    </Link>
  );
}
