import { useEffect, useRef, useState } from "react";

import { EmojiConfetti, burst } from "@/components/party/emoji-confetti";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import { reactionName, REACTIONS, useParty, usePartyReactions, useSendReaction } from "@/lib/party";
import { cn } from "@/lib/utils";

// How long someone else's reaction is named: long enough to read, short
// enough to stay out of the way.
const labelMs = 1500;

// The eight emoji, a tap each. `chrome` is the player's chrome over the video
// (the dock, a row above the seek bar): a small glass capsule, the emoji a
// little larger than in a page, and a click that is the emoji's alone, from a
// pointer or the keyboard (Tab and Enter; a mouse's click gives the keyboard
// back, so Space still pauses). Nothing bursts here: Go sends the reaction
// back to everyone, this member included, so the layer below is the one place
// confetti starts. Out of a party, or while its channel reconnects, a tap
// would go nowhere, so the buttons are off.
export function ReactionBar({
  chrome = false,
  className,
}: {
  chrome?: boolean;
  className?: string;
}) {
  const party = useParty()?.party;
  const send = useSendReaction();
  const ready = Boolean(party?.connected);
  // A fieldset, not a div with a role: it is the element for a group of
  // controls, so it is named with an aria-label the way the player's other
  // groups are, and its border, padding and margin are reset to keep the row.
  return (
    <fieldset
      aria-label="Reactions"
      className={cn(
        "m-0 flex min-w-0 items-center border-0 p-0",
        // The player's glass tier for chrome buttons (material-media), sized
        // to a 2.5 rem row so the dock can make exactly that room for it.
        chrome
          ? "mx-auto h-10 w-fit justify-center gap-0.5 rounded-full px-1.5 material-media"
          : "gap-0.5",
        className,
      )}
    >
      {REACTIONS.map((emoji) => (
        <Button
          key={emoji}
          variant="ghost"
          size="icon-sm"
          disabled={!ready}
          onClick={(event) => {
            // Over the video a click is the emoji's, not the picture's (a
            // pause).
            event.stopPropagation();
            // A light tap as it sends one on iOS (#135); nothing elsewhere.
            haptic("light");
            send(emoji);
            // A pointer's click doesn't keep the keyboard, so Space stays the
            // player's pause rather than a second press of the emoji just
            // clicked. A keyboard's Enter has no click count and keeps its
            // place for the next Tab.
            if (event.detail > 0) event.currentTarget.blur();
          }}
          // Nor is a double click's, which the picture takes as full screen.
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={`React with ${reactionName[emoji]}`}
          title={`React with ${reactionName[emoji]}`}
          className={cn(
            "leading-none motion-safe:active:scale-90",
            chrome ? "text-[1.25rem] text-white hover:bg-white/15" : "text-[1.0625rem]",
          )}
        >
          <span aria-hidden>{emoji}</span>
        </Button>
      ))}
    </fieldset>
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
          // Just above the dock, where the player's other overlays sit. Named
          // above the confetti layer, which is z-30 too and comes first; still
          // under the menus and sheets at z-50.
          className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--above-bar)+0.5rem)] z-30 flex justify-center"
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
