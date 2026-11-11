import { useState } from "react";

import { subtitlePreviewStyle, type SubtitleStyle } from "@/components/player/subtitle-panel";
import { lineCount, secondLine, useWindowHeight } from "@/lib/subtitle-position";

// The second line of subtitles (dual subtitles), drawn over the video: mpv
// 0.41 has no secondary-sub-scale, so Go keeps mpv's own drawing of it off and
// reports the text (State.secondarySubtitleText). It's smaller than the main
// subtitles, in their style, and stands right above them wherever they are:
// `lift` is the one the main subtitles are drawn with now. The mini player
// has no room for it and doesn't mount this.
export function SecondSubtitles({
  text,
  mainText,
  mainOn,
  style,
  lift,
}: {
  text: string;
  // The main subtitles' line now, and whether they're on at all.
  mainText: string;
  mainOn: boolean;
  style: SubtitleStyle;
  lift: number;
}) {
  const height = useWindowHeight();
  // The main subtitles' height, held between their lines so the second line
  // doesn't drop to the bottom and jump back at each gap.
  const [held, setHeld] = useState(1);
  const lines = lineCount(mainText);
  if (lines > 0 && lines !== held) setHeld(lines);
  const { bottom, base } = secondLine(height, { size: style.size, lift }, mainOn ? held : 0);
  if (!text) return null;
  return (
    <div
      aria-hidden
      data-testid="second-subtitles"
      className="pointer-events-none absolute inset-x-0 flex justify-center px-[10%]"
      style={{ bottom }}
    >
      <p className="max-w-full text-center text-balance whitespace-pre-line">
        <span style={subtitlePreviewStyle(style, base)}>{text}</span>
      </p>
    </div>
  );
}
