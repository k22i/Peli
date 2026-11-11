import { Ellipsis, Repeat, X } from "lucide-react";

import { PlayerMenu, PlayerMenuGroup, PlayerMenuItem } from "@/components/player/player-menu";
import { nextLoopLabel, type Loop } from "@/lib/ab-loop";
import { formatTime } from "@/lib/player";

export type LoopProps = {
  loop: Loop;
  // L's next step: set A, set B, or clear.
  onNext: () => void;
  onClear: () => void;
};

// The dock's More menu: the rarer actions, each with its key.
export function MoreMenu({
  open,
  onOpenChange,
  loop,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loop: LoopProps;
}) {
  const { a, b } = loop.loop;
  return (
    <PlayerMenu
      label="More"
      open={open}
      onOpenChange={onOpenChange}
      lit={a !== undefined}
      trigger={<Ellipsis />}
    >
      <PlayerMenuGroup label="A–B loop">
        {a !== undefined && b !== undefined ? (
          <PlayerMenuItem
            icon={<X aria-hidden />}
            hint={`${formatTime(a)}–${formatTime(b)}`}
            onClick={loop.onClear}
          >
            Stop looping
          </PlayerMenuItem>
        ) : (
          <PlayerMenuItem icon={<Repeat aria-hidden />} hint="L" onClick={loop.onNext}>
            {nextLoopLabel(loop.loop)}
          </PlayerMenuItem>
        )}
        {a !== undefined && b === undefined && (
          <PlayerMenuItem
            icon={<X aria-hidden />}
            hint={`A at ${formatTime(a)}`}
            onClick={loop.onClear}
          >
            Forget A
          </PlayerMenuItem>
        )}
      </PlayerMenuGroup>
    </PlayerMenu>
  );
}
