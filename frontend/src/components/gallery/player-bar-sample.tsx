import { Slider } from "@base-ui/react/slider";
import {
  Keyboard,
  ListVideo,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { busy } from "@/components/gallery/materials";
import { GallerySection } from "@/components/gallery/gallery-section";
import { SeekBar } from "@/components/player/seek-bar";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/player";
import { cn } from "@/lib/utils";

const duration = 7468;
const segments = [
  { kind: "intro", start: 120, end: 210 },
  { kind: "credits", start: 7240, end: 7468 },
];

// A round button as the player's bar draws it: bare, white, a faint wash on
// hover. The real ones are `ControlButton` in player-page.tsx.
function BarButton({
  label,
  icon: Icon,
  large,
  fill,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  large?: boolean;
  fill?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "rounded-full text-white hover:bg-white/15 hover:text-white",
        large && "size-12 sm:size-12",
      )}
    >
      <Icon className={cn(large ? "size-7" : "size-5", fill && "fill-current")} />
    </Button>
  );
}

// The player's control bar (#121) over a stand-in frame: a `glass-media-strong`
// capsule with the real SeekBar, plain white text and the same button layout.
// Over the real player the video is a native layer under the webview, so the
// blur sees nothing there (ADR-0046); the busy frame here shows the tint and
// the edge, and the blur if your browser draws it.
export function PlayerBarSample() {
  const [position, setPosition] = useState(4320);
  const [playing, setPlaying] = useState(true);
  const [volume, setVolume] = useState(72);

  return (
    <GallerySection
      title="Player bar"
      description="The floating control bar from the player: a glass-media-strong capsule, the seek bar with its intro and credits marks, and plain white text and icons so it stays readable over a white frame. Drag the seek bar, or press Play."
    >
      <div className="dark relative h-80 overflow-hidden rounded-3xl text-foreground" style={busy}>
        <div className="absolute inset-x-0 bottom-0 h-40 bg-linear-to-t from-black/40 to-transparent" />
        <div className="absolute inset-x-4 bottom-4 mx-auto flex max-w-3xl flex-col gap-1 rounded-[1.75rem] px-5 pt-3 pb-2.5 glass-media-strong">
          <div className="flex items-center gap-3">
            <p className="w-[7ch] shrink-0 text-num text-caption text-white">
              {formatTime(position)}
            </p>
            <div className="min-w-0 flex-1">
              <SeekBar
                position={position}
                duration={duration}
                buffered={420}
                segments={segments}
                playing={playing}
                onScrub={setPosition}
                onSeek={setPosition}
                onDraggingChange={() => {}}
              />
            </div>
            <p className="w-[8ch] shrink-0 text-end text-num text-caption text-white">
              -{formatTime(Math.max(0, duration - position))}
            </p>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center">
            <div className="flex items-center">
              <BarButton label="Mute" icon={Volume2} />
              <Slider.Root
                value={volume}
                min={0}
                max={100}
                onValueChange={(value) => setVolume(value)}
                className="hidden w-24 sm:block"
              >
                <Slider.Control className="flex h-8 cursor-pointer touch-none items-center px-2 select-none">
                  <Slider.Track className="relative h-1 w-full rounded-full bg-white/25">
                    <Slider.Indicator className="rounded-full bg-white" />
                    <Slider.Thumb
                      aria-label="Volume"
                      className="size-3 rounded-full bg-white shadow-md outline-none has-focus-visible:ring-2 has-focus-visible:ring-white/60"
                    />
                  </Slider.Track>
                </Slider.Control>
              </Slider.Root>
            </div>
            <div className="flex items-center gap-2">
              <BarButton
                label="Back 10 seconds"
                icon={RotateCcw}
                onClick={() => setPosition(Math.max(0, position - 10))}
              />
              <BarButton
                label={playing ? "Pause" : "Play"}
                icon={playing ? Pause : Play}
                large
                fill
                onClick={() => setPlaying(!playing)}
              />
              <BarButton
                label="Forward 10 seconds"
                icon={RotateCw}
                onClick={() => setPosition(Math.min(duration, position + 10))}
              />
            </div>
            <div className="flex items-center justify-self-end gap-1">
              <BarButton label="Streams" icon={ListVideo} />
              <BarButton label="Keyboard shortcuts" icon={Keyboard} />
              <BarButton label="Full screen" icon={Maximize} />
            </div>
          </div>
        </div>
      </div>
    </GallerySection>
  );
}
