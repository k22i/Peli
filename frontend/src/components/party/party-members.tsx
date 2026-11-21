import { Crown, UserMinus } from "lucide-react";
import { useState } from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { errorCode, memberStatus, Party, partyProblem, type Member } from "@/lib/party";
import { cn } from "@/lib/utils";

// Who is in the party and how each is doing: watching, loading, behind, or
// offline. The host can remove anyone else, who can't join again.
export function PartyMembers({
  members,
  maxMembers,
  isHost,
}: {
  members: readonly Member[];
  maxMembers: number;
  isHost: boolean;
}) {
  const [removing, setRemoving] = useState<Member>();
  const remove = (member: Member) => {
    setRemoving(undefined);
    Party.RemoveMember(member.id).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: `Couldn’t remove ${member.name}`,
        description: partyProblem(errorCode(error)),
      }),
    );
  };
  return (
    <section aria-label="People" className="flex flex-col gap-1">
      <p className="px-1 pb-1 text-small text-muted-foreground tnum">
        {members.length} of {maxMembers} seats
      </p>
      <ul className="flex flex-col">
        {members.map((member) => (
          <li key={member.id} className="flex items-center gap-3 rounded-xl px-1 py-2">
            <ProfileAvatar
              profile={{
                name: member.name,
                avatar: member.avatarUrl,
                avatarColor: member.avatarColor,
              }}
              className="size-9 text-xs"
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <p className="flex items-center gap-1.5 truncate text-body font-[590]">
                {member.name}
                {member.you && <span className="font-normal text-muted-foreground">(you)</span>}
                {member.host && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sun/15 px-1.5 py-0.5 text-[0.6875rem] font-[650] text-sun-ink">
                    <Crown aria-hidden className="size-3" />
                    Host
                  </span>
                )}
              </p>
              <p
                className={cn(
                  "flex items-center gap-1.5 truncate text-small",
                  member.status === "offline"
                    ? "text-muted-foreground/70"
                    : "text-muted-foreground",
                )}
              >
                <StatusDot status={member.watchingElse ? "else" : member.status} />
                {memberStatus(member)}
              </p>
            </div>
            {isHost && !member.you && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${member.name}`}
                // 44 pt for a finger (ADR-0063).
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                onClick={() => setRemoving(member)}
              >
                <UserMinus />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <AlertDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They won’t be able to join this party again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => removing && remove(removing)}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "ready" && "bg-success",
        (status === "loading" || status === "buffering") && "bg-warning",
        status === "behind" && "bg-info",
        (status === "browsing" || status === "else") && "bg-muted-foreground/60",
        status === "offline" && "bg-muted-foreground/30",
      )}
    />
  );
}
