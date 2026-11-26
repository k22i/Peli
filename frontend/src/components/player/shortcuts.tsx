import { X } from "lucide-react";
import { Fragment } from "react";

import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { isIOS } from "@/lib/platform";

// The player's keys (#67), as the help overlay lists them; player-page.tsx
// handles them. Space, F, M, Z and X are mpv's, K, C and I YouTube's.
// `desktop` marks the keys the iOS player leaves alone (iosKeysOff in
// player-page.tsx, #138): the overlay doesn't list them on an iPad.
export const playerShortcuts: {
  group: string;
  items: { keys: string[]; action: string; desktop?: true }[];
}[] = [
  {
    group: "Playback",
    items: [
      { keys: ["Space", "K"], action: "Play or pause" },
      { keys: ["←", "→"], action: "Back or forward 10 seconds" },
      { keys: ["↑", "↓"], action: "Volume up or down" },
      { keys: ["[", "]"], action: "Slower or faster" },
      { keys: ["Backspace"], action: "Normal speed" },
      { keys: [",", "."], action: "A frame back or forward, paused", desktop: true },
      { keys: ["Page Up", "Page Down"], action: "Previous or next chapter" },
      { keys: ["L"], action: "Set A, set B, then clear an A–B loop", desktop: true },
      { keys: ["Shift S"], action: "Screenshot, with the subtitles showing", desktop: true },
      { keys: ["Shift I"], action: "Playback stats" },
      { keys: ["M"], action: "Mute or unmute" },
      { keys: ["F"], action: "Full screen", desktop: true },
      { keys: ["I"], action: "Mini player", desktop: true },
      { keys: ["S"], action: "Choose another stream", desktop: true },
      { keys: ["W"], action: "Watch party (opens beside the video when Keep open is on)" },
      { keys: ["P"], action: "Picture and sound", desktop: true },
      { keys: ["Shift F"], action: "Fit, fill, stretch or original size", desktop: true },
      { keys: ["Shift A"], action: "Next aspect ratio", desktop: true },
      { keys: ["=", "−"], action: "Zoom in or out", desktop: true },
      { keys: ["0"], action: "Zoom back to 1×", desktop: true },
      { keys: ["⌥ ←→↑↓"], action: "Move the zoomed picture", desktop: true },
      { keys: ["Esc"], action: "Leave the mini player or full screen, then the player" },
    ],
  },
  {
    group: "Audio and subtitles",
    items: [
      { keys: ["A"], action: "Next audio track" },
      { keys: ["B"], action: "Dialogue boost on or off", desktop: true },
      { keys: ["C"], action: "Next subtitles, then off" },
      { keys: ["Shift C"], action: "Next second-line subtitles, then off" },
      { keys: ["Z", "X"], action: "Subtitles 0.1 s earlier or later" },
      { keys: ["R", "Shift R"], action: "Move subtitles up or down" },
      { keys: ["G", "Shift G"], action: "Make subtitles smaller or larger" },
    ],
  },
  {
    // While the Streams panel (S) is open; the stream picker's keys too.
    group: "In the Streams panel",
    items: [
      { keys: ["P"], action: "Play the top pick", desktop: true },
      { keys: ["↑", "↓"], action: "Move through the streams", desktop: true },
      { keys: ["I"], action: "Show a stream’s file name", desktop: true },
      { keys: ["1–9"], action: "Jump to the top pick or a quality group", desktop: true },
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
  const ios = isIOS();
  const groups = playerShortcuts
    .map(({ group, items }) => ({ group, items: items.filter((item) => !(ios && item.desktop)) }))
    .filter(({ items }) => items.length > 0);
  return (
    <section
      aria-label="Keyboard shortcuts"
      className="dark absolute top-1/2 left-1/2 w-[min(28rem,calc(100%-2rem))] -translate-1/2 rounded-3xl max-h-[calc(100%-2rem)] overflow-y-auto p-5 text-foreground material-media"
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
        {groups.map(({ group, items }) => (
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
