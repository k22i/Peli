import { useEffect, useRef, useState } from "react";

import { EmojiConfetti, burst } from "@/components/party/emoji-confetti";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import {
  reactionName,
  REACTIONS,
  useParty,
  usePartyReactions,
  useSendReaction,
} from "@/lib/party";
import { cn } from "@/lib/utils";

// How long someone else's reaction is named: long enough to read, short
// enough to stay out of the way.
const labelMs = 1500;

// The eight emoji, a tap each, above the chat's message box. Nothing bursts
// here: Go sends the reaction back to everyone, this member included, so the
// layer below is the one place confetti starts. Out of a party, or while its
// channel reconnects, a tap would go nowhere, so the buttons are off.
export function ReactionBar({ className }: { className?: string }) {
  const party = useParty()?.party;
  const send = useSendReaction();
  const ready = Boolean(party?.connected);
  return (
    <div
      role="group"
      aria-label="Reactions"
      className={cn("flex items-center gap-0.5", className)}
    >
      {REACTIONS.map((emoji) => (
        <Button
          key={emoji}
          variant="ghost"
          size="icon-sm"
          disabled={!ready}
          // A light tap as it sends one on iOS (#135); nothing elsewhere.
          onClick={() => {
            haptic("light");
            send(emoji);
          }}
          aria-label={`React with ${reactionName[emoji]}`}
          title={`React with ${reactionName[emoji]}`}
          className="text-[1.0625rem] leading-none motion-safe:active:scale-90"
        >
          <span aria-hidden>{emoji}</span>
        </Button>
      ))}
    </div>
  );
}

// The player's reactions (ADR-0051): the confetti every emoji bursts, and a
// quiet line naming who sent one. The sender's own reaction bursts too but
// isn't named: they tapped it. One line at a time, the newer one replacing
// the older.
export function PartyReactionLayer() {
  const [said, setSaid] = useState<{ key: number; text: string }>();
  const seen = useRef(0);
  usePartyReactions((reaction) => {
    burst(reaction.emoji);
    if (reaction.mine) return;
    seen.current += 1;
    setSaid({ key: seen.current, text: `${reaction.name} ${reaction.emoji}` });
  });
  useEffect(() => {
    if (!said) return undefined;
    const timer = setTimeout(() => setSaid(undefined), labelMs);
    return () => clearTimeout(timer);
  }, [said]);
  return (
    <>
      <EmojiConfetti />
      {said && (
        <div
          // Not for a screen reader: the confetti already says it, and the
          // chat is where a member looks for what was said.
          aria-hidden
          // Just above the dock, where the player's other overlays sit.
          className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--above-bar)+0.5rem)] flex justify-center"
        >
          <p
            key={said.key}
            className="text-small font-[600] text-white drop-shadow-[0_1px_6px_rgb(0_0_0/0.55)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300"
          >
            {said.text}
          </p>
        </div>
      )}
    </>
  );
}
