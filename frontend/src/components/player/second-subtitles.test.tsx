import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { defaultSubtitleStyle } from "@/components/player/subtitle-panel";
import { secondLine } from "@/lib/subtitle-position";

import { SecondSubtitles } from "./second-subtitles";

const bottomOf = () => Number.parseInt(screen.getByTestId("second-subtitles").style.bottom, 10);

function renderLine(props: Partial<Parameters<typeof SecondSubtitles>[0]> = {}) {
  return render(
    <SecondSubtitles
      text="Hello"
      mainText="Bonjour"
      mainOn
      style={defaultSubtitleStyle}
      lift={0}
      {...props}
    />,
  );
}

describe("SecondSubtitles", () => {
  it("draws the line over the video, where the screen can't read it twice", () => {
    renderLine();
    const line = screen.getByTestId("second-subtitles");
    expect(line.textContent).toBe("Hello");
    expect(line.getAttribute("aria-hidden")).toBe("true");
    expect(line.className).toContain("pointer-events-none");
  });

  it("shows nothing between lines", () => {
    renderLine({ text: "" });
    expect(screen.queryByTestId("second-subtitles")).toBeNull();
  });

  it("stands above the main subtitles and moves with their lift", () => {
    const { rerender } = renderLine();
    const low = bottomOf();
    expect(low).toBe(secondLine(window.innerHeight, { size: 100, lift: 0 }, 1).bottom);
    rerender(
      <SecondSubtitles
        text="Hello"
        mainText="Bonjour"
        mainOn
        style={defaultSubtitleStyle}
        lift={10}
      />,
    );
    expect(bottomOf()).toBeGreaterThan(low);
  });

  it("makes room for each line of the main subtitles, and keeps it between lines", () => {
    const { rerender } = renderLine({ mainText: "One\nTwo" });
    const two = bottomOf();
    rerender(
      <SecondSubtitles text="Hello" mainText="" mainOn style={defaultSubtitleStyle} lift={0} />,
    );
    expect(bottomOf()).toBe(two);
  });

  it("sits at the bottom when the main subtitles are off", () => {
    const { rerender } = renderLine();
    const above = bottomOf();
    rerender(
      <SecondSubtitles
        text="Hello"
        mainText=""
        mainOn={false}
        style={defaultSubtitleStyle}
        lift={0}
      />,
    );
    expect(bottomOf()).toBeLessThan(above);
  });
});
