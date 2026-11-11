import { Ellipsis, ListOrdered, Repeat, X } from "lucide-react";

import {
  PlayerMenu,
  PlayerMenuGroup,
  PlayerMenuItem,
  PlayerMenuRadioGroup,
  PlayerMenuRadioItem,
  PlayerMenuSeparator,
  PlayerSubmenu,
} from "@/components/player/player-menu";
import { nextLoopLabel, type Loop } from "@/lib/ab-loop";
import { chapterName, type Chapter } from "@/lib/chapters";
import { formatTime } from "@/lib/player";

export type LoopProps = {
  loop: Loop;
  // L's next step: set A, set B, or clear.
  onNext: () => void;
  onClear: () => void;
};

export type ChaptersProps = {
  chapters: readonly Chapter[];
  // The one playing, -1 before the first.
  current: number;
  onPick: (index: number) => void;
};

// The dock's More menu: the rarer actions, each with its key.
export function MoreMenu({
  open,
  onOpenChange,
  chapters,
  loop,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chapters: ChaptersProps;
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
      {chapters.chapters.length > 1 && (
        <>
          <PlayerSubmenu
            icon={<ListOrdered aria-hidden />}
            label="Chapters"
            hint={
              chapters.current >= 0
                ? `${chapters.current + 1} of ${chapters.chapters.length}`
                : undefined
            }
          >
            <PlayerMenuRadioGroup
              label="Chapters"
              value={chapters.current}
              onChange={chapters.onPick}
            >
              {chapters.chapters.map((chapter, index) => (
                <PlayerMenuRadioItem
                  key={chapter.time}
                  value={index}
                  hint={formatTime(chapter.time)}
                >
                  {chapterName(chapter, index)}
                </PlayerMenuRadioItem>
              ))}
            </PlayerMenuRadioGroup>
          </PlayerSubmenu>
          <PlayerMenuSeparator />
        </>
      )}
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
