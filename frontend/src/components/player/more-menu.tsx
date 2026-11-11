import { Activity, Camera, Ellipsis, ListOrdered, Moon, Repeat, X } from "lucide-react";

import {
  PlayerMenu,
  PlayerMenuCheckboxItem,
  PlayerMenuGroup,
  PlayerMenuItem,
  PlayerMenuRadioGroup,
  PlayerMenuRadioItem,
  PlayerMenuSeparator,
  PlayerSubmenu,
} from "@/components/player/player-menu";
import { nextLoopLabel, type Loop } from "@/lib/ab-loop";
import { chapterName, type Chapter } from "@/lib/chapters";
import { sleepChoices, type SleepChoice } from "@/lib/sleep-timer";
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

export type SleepProps = {
  choice: SleepChoice;
  // What's left: "12 min", "End of episode".
  hint: string | undefined;
  // Whether the episode's length is known, for "End of episode".
  episodeKnown: boolean;
  onChange: (choice: SleepChoice) => void;
};

// The dock's More menu: the rarer actions, each with its key.
export function MoreMenu({
  open,
  onOpenChange,
  chapters,
  loop,
  onScreenshot,
  stats,
  sleep,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chapters: ChaptersProps;
  loop: LoopProps;
  // Saves the frame, with the subtitles showing or without.
  onScreenshot: (subtitles: boolean) => void;
  stats: { open: boolean; onToggle: () => void };
  sleep: SleepProps;
}) {
  const { a, b } = loop.loop;
  return (
    <PlayerMenu
      label="More"
      open={open}
      onOpenChange={onOpenChange}
      lit={a !== undefined || sleep.choice !== "off"}
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
      <PlayerMenuSeparator />
      <PlayerMenuGroup label="Screenshot">
        <PlayerMenuItem icon={<Camera aria-hidden />} hint="⇧S" onClick={() => onScreenshot(true)}>
          Take a screenshot
        </PlayerMenuItem>
        <PlayerMenuItem onClick={() => onScreenshot(false)}>Without subtitles</PlayerMenuItem>
      </PlayerMenuGroup>
      <PlayerMenuSeparator />
      <PlayerMenuCheckboxItem checked={stats.open} onChange={stats.onToggle} hint="⇧I">
        <span className="flex items-center gap-3">
          <Activity aria-hidden className="size-4.5" />
          Playback stats
        </span>
      </PlayerMenuCheckboxItem>
      <PlayerSubmenu icon={<Moon aria-hidden />} label="Sleep timer" hint={sleep.hint ?? "Off"}>
        <PlayerMenuRadioGroup label="Sleep timer" value={sleep.choice} onChange={sleep.onChange}>
          {sleepChoices
            .filter((each) => each.value !== "episode" || sleep.episodeKnown)
            .map((each) => (
              <PlayerMenuRadioItem key={each.value} value={each.value}>
                {each.name}
              </PlayerMenuRadioItem>
            ))}
        </PlayerMenuRadioGroup>
      </PlayerSubmenu>
    </PlayerMenu>
  );
}
