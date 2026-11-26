import { PartyPopper, Users } from "lucide-react";
import { useState } from "react";

import { Artwork } from "@/components/media/artwork";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import {
  errorCode,
  mediaLabel,
  partyProblem,
  useAccountParties,
  usePartyActions,
  type AccountParty,
} from "@/lib/party";

// The account's live parties (ADR-0067): a party another profile of this
// Nuvio account hosts, listed on the Join page so it can be joined with one
// click and no code to share. Go announces the party in the account's synced
// data and confirms each one before listing it, so a party that ended is
// never shown; when the backend can't be reached the list is empty and the
// code still works.
export function AccountParties() {
  const { parties, pending } = useAccountParties();
  if (pending) {
    return (
      <div aria-hidden className="flex flex-col gap-2">
        <Skeleton className="h-16 rounded-2xl" />
      </div>
    );
  }
  if (parties.length === 0) {
    return (
      <p className="text-small text-muted-foreground">
        No one on this account is watching together right now. Start something and press W to host
        one.
      </p>
    );
  }
  return (
    <ul aria-label="Parties on this account" className="flex flex-col gap-2">
      {parties.map((party) => (
        <AccountPartyRow key={party.id} party={party} />
      ))}
    </ul>
  );
}

function AccountPartyRow({ party }: { party: AccountParty }) {
  const { join } = usePartyActions();
  const [joining, setJoining] = useState(false);
  const full = party.maxMembers > 0 && party.members >= party.maxMembers;
  const submit = () => {
    setJoining(true);
    join(party.code).catch((error: unknown) => {
      setJoining(false);
      toastManager.add({
        type: "error",
        title: "Couldn’t join the watch party",
        description: partyProblem(errorCode(error)),
      });
    });
  };
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-foreground/5 p-3">
      {party.media.poster ? (
        <Artwork
          src={party.media.poster}
          use="poster"
          title={party.media.title}
          className="aspect-[2/3] w-12 shrink-0 rounded-lg"
        />
      ) : (
        <span className="grid aspect-[2/3] w-12 shrink-0 place-items-center rounded-lg bg-foreground/8">
          <PartyPopper aria-hidden className="size-5 text-muted-foreground" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-body font-[590]">{mediaLabel(party.media)}</p>
        <p className="truncate text-small text-muted-foreground">
          {party.host ? `Hosted by ${party.host} · ` : ""}
          <span className="tnum">
            {party.members} of {party.maxMembers} seats
          </span>
        </p>
      </div>
      <Button
        variant="secondary"
        className="pointer-coarse:min-h-11"
        disabled={joining || full}
        onClick={submit}
      >
        {joining ? <Spinner /> : <Users />}
        {full ? "Full" : "Join"}
      </Button>
    </li>
  );
}
