import { PartyPopper, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import { PartyChat } from "@/components/party/party-chat";
import { JoinParty, PartyPanel } from "@/components/party/party-panel";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import {
  duration,
  errorCode,
  partyProblem,
  useParty,
  usePartyActions,
  usePartyChat,
  type Media,
  type PartyInfo,
  type State,
} from "@/lib/party";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";

// The player's watch party sheet (W): start one for what's playing, or join
// one with a code; in one, its people and controls, and the chat. On the
// compact iOS shell (ADR-0063) it is a bottom sheet from the edge instead, as
// the shell's other sheets are, and it gives the chat the room the on-screen
// keyboard leaves (--keyboard-h, lib/keyboard.ts) so the field and its send
// button stay above the keys.
export function PartySheet({
  open,
  onOpenChange,
  state,
  media,
  canShare,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: State | undefined;
  // What's playing, as the party would name it; undefined when it isn't a
  // film or episode a party can watch.
  media: Media | undefined;
  canShare: boolean;
}) {
  const compact = useCompactShell();
  const party = state?.party ?? undefined;
  const description = party
    ? party.isHost
      ? "You’re hosting. Everyone plays from their own sources, in step with you."
      : "Everyone plays from their own sources, in step with the host."
    : "Invite friends on Peli or Nuvio. Everyone plays from their own sources and stays in step.";
  if (compact) {
    return (
      <BottomSheet
        open={open}
        onOpenChange={onOpenChange}
        label="Watch party"
        header={
          <>
            <BottomSheetTitle>Watch party</BottomSheetTitle>
            <p className="px-5 pb-3 text-center text-small text-muted-foreground">{description}</p>
          </>
        }
        // As tall as the picture leaves: a panel with a chat needs the room,
        // and the keyboard's height is padding, so what's above it is left.
        className="dark h-[min(44rem,85dvh)] max-h-none pb-[max(env(safe-area-inset-bottom),var(--keyboard-h,0px))] text-foreground"
      >
        <div className="flex h-full min-h-0 flex-col">
          {party ? (
            <InParty canShare={canShare} compact />
          ) : (
            <NotInParty state={state} media={media} onJoined={() => onOpenChange(false)} />
          )}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="dark max-w-md text-foreground">
        <SheetHeader className="px-6 pb-2">
          <SheetTitle>Watch party</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6">
          {party ? (
            <InParty canShare={canShare} />
          ) : (
            <NotInParty state={state} media={media} onJoined={() => onOpenChange(false)} />
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

function InParty({ canShare, compact = false }: { canShare: boolean; compact?: boolean }) {
  const chat = usePartyChat();
  const [tab, setTab] = useState<string>("party");
  // A finger's 44 pt rows in the sheet; the panel's own rows are 34 pt.
  const tabClass = compact ? "pointer-coarse:min-h-11" : undefined;
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(String(value))}
      className="min-h-0 flex-1 gap-4"
    >
      <TabsList className={cn("w-full", compact && "shrink-0")}>
        <TabsTab value="party" className={tabClass}>
          Party
        </TabsTab>
        <TabsTab value="chat" className={tabClass}>
          Chat
          {chat.unread > 0 && tab !== "chat" && (
            <span className="ms-1.5 grid min-w-4.5 place-items-center rounded-full bg-sun px-1 text-[0.625rem] font-[700] text-sun-foreground tnum">
              {chat.unread}
            </span>
          )}
        </TabsTab>
      </TabsList>
      <TabsPanel value="party">
        <PartyStateGate>
          {(party) => <PartyPanel party={party} canShare={canShare} />}
        </PartyStateGate>
      </TabsPanel>
      {/* In the sheet the chat takes the room under the two tabs: its list
          scrolls, and its field stays at the bottom, above the keyboard. */}
      <TabsPanel
        value="chat"
        className={compact ? "flex min-h-0 flex-1 flex-col" : "flex min-h-[24rem] flex-col"}
      >
        <PartyChat />
      </TabsPanel>
    </Tabs>
  );
}

function PartyStateGate({ children }: { children: (party: PartyInfo) => ReactNode }) {
  const party = useParty()?.party;
  return party ? children(party) : null;
}

function NotInParty({
  state,
  media,
  onJoined,
}: {
  state: State | undefined;
  media: Media | undefined;
  onJoined: () => void;
}) {
  const { create } = usePartyActions();
  const [starting, setStarting] = useState(false);
  if (state?.unavailable) {
    return (
      <div className="flex flex-col items-start gap-3 py-6">
        <Users aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-body">{partyProblem(state.unavailable)}</p>
      </div>
    );
  }
  const start = () => {
    if (!media) return;
    setStarting(true);
    create(media).then(
      () => setStarting(false),
      (error: unknown) => {
        setStarting(false);
        toastManager.add({
          type: "error",
          title: "Couldn’t start the watch party",
          description: partyProblem(errorCode(error)),
        });
      },
    );
  };
  return (
    <div className="flex flex-col gap-8 pt-2">
      {media && (
        <div className="flex flex-col gap-3">
          <Button
            variant="sun"
            size="lg"
            className="pointer-coarse:min-h-11"
            onClick={start}
            disabled={starting || state?.busy}
          >
            {starting ? <Spinner /> : <PartyPopper />}
            Start a watch party
          </Button>
          <p className="text-small text-muted-foreground">
            You’ll get a code to share. Friends join it from Peli, or from Nuvio on any device.
          </p>
        </div>
      )}
      <div className="flex flex-col gap-3">
        <p className="type-eyebrow text-muted-foreground">
          {media ? "Or join one" : "Join a watch party"}
        </p>
        <JoinParty onJoined={onJoined} />
      </div>
    </div>
  );
}

// A line at the top of the video while the party has something to say: a
// member's action for a moment, then the party's state (reconnecting,
// behind with Catch up, waiting for someone). `className` places it: the
// touch player puts it under its own top row (#130).
export function PartyPill({
  state,
  notice,
  onCatchUp,
  className,
}: {
  state: State | undefined;
  notice: string | undefined;
  onCatchUp: () => void;
  className?: string | false | undefined;
}) {
  const party = state?.party;
  if (!party) return null;
  let text: string | undefined = notice;
  let catchUp = false;
  if (!text && party.watching) {
    if (!party.connected) text = "Reconnecting to the party…";
    else if (party.behind) {
      text = `You’re ${duration(party.behindMs)} behind the party`;
      catchUp = true;
    } else if (party.waiting)
      text =
        party.waitingFor && party.waitingFor.length === 1
          ? `Waiting for ${party.waitingFor[0]}`
          : "Waiting for everyone";
  }
  if (!text) return null;
  return (
    <div
      aria-live="polite"
      className={cn("pointer-events-none absolute inset-x-0 top-5 flex justify-center", className)}
    >
      <p
        className={cn(
          "pointer-events-auto flex items-center gap-2 rounded-full bg-black/60 py-1.5 text-small font-[600] text-white shadow-float backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in-0",
          catchUp ? "ps-4 pe-1.5" : "px-4",
        )}
      >
        <Users aria-hidden className="size-3.5 text-white/80" />
        <span className="tnum">{text}</span>
        {catchUp && (
          <Button size="xs" variant="light" className="rounded-full" onClick={onCatchUp}>
            Catch up
          </Button>
        )}
      </p>
    </div>
  );
}
