import { X } from "lucide-react";
import { Fragment } from "react";

import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

// The player's keys (#67), as the help overlay lists them; player-page.tsx
// handles them. Space, F, M, Z and X are mpv's, K, C and I YouTube's.
export const playerShortcuts: { group: string; items: { keys: string[]; action: string }[] }[] = [
  {
    group: "Playback",
    items: [
      { keys: ["Space", "K"], action: "Play or pause" },
      { keys: ["←", "→"], action: "Back or forward 10 seconds" },
      { keys: ["↑", "↓"], action: "Volume up or down" },
      { keys: ["[", "]"], action: "Slower or faster" },
      { keys: ["Backspace"], action: "Normal speed" },
      { keys: [",", "."], action: "A frame back or forward, paused" },
      { keys: ["M"], action: "Mute or unmute" },
      { keys: ["F"], action: "Full screen" },
      { keys: ["I"], action: "Mini player" },
      { keys: ["S"], action: "Choose another stream" },
      { keys: ["W"], action: "Watch party" },
      { keys: ["P"], action: "Picture and sound" },
      { keys: ["Shift F"], action: "Fit, fill, stretch or original size" },
      { keys: ["Shift A"], action: "Next aspect ratio" },
      { keys: ["=", "−"], action: "Zoom in or out" },
      { keys: ["0"], action: "Zoom back to 1×" },
      { keys: ["⌥ ←→↑↓"], action: "Move the zoomed picture" },
      { keys: ["Esc"], action: "Leave the mini player or full screen, then the player" },
    ],
  },
  {
    group: "Audio and subtitles",
    items: [
      { keys: ["A"], action: "Next audio track" },
      { keys: ["B"], action: "Dialogue boost on or off" },
      { keys: ["C"], action: "Next subtitles, then off" },
      { keys: ["Shift C"], action: "Next second-line subtitles, then off" },
      { keys: ["Z", "X"], action: "Subtitles 0.1 s earlier or later" },
      { keys: ["R", "Shift R"], action: "Move subtitles up or down" },
      { keys: ["G", "Shift G"], action: "Make subtitles smaller or larger" },
    ],
  },
  {
    group: "Help",
    items: [{ keys: ["?"], action: "Show or hide these shortcuts" }],
  },
];

// The shortcuts over the video, on strong media material-pop like the rest of the
// player's chrome (#121); text is plain white so it reads over a white frame.
// It doesn't take focus or the keys: they keep working while it shows.
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <section
      aria-label="Keyboard shortcuts"
      className="dark absolute top-1/2 left-1/2 w-[min(28rem,calc(100%-2rem))] -translate-1/2 rounded-3xl p-5 text-foreground material-media"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          className="rounded-full text-white hover:bg-white/15 hover:text-white"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="flex flex-col gap-4">
        {playerShortcuts.map(({ group, items }) => (
          <div key={group}>
            <h3 className="mb-1.5 type-eyebrow">{group}</h3>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
              {items.map(({ keys, action }) => (
                <Fragment key={action}>
                  <dt>
                    <KbdGroup>
                      {keys.map((key) => (
                        <Kbd key={key} className="bg-black/30 text-white">
                          {key}
                        </Kbd>
                      ))}
                    </KbdGroup>
                  </dt>
                  <dd>{action}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
