import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Track } from "@/lib/player";
import type { AddonSubtitle } from "@/lib/subtitles";
import { hasFocusRing, keyboardReachable } from "@/test/focus";

import {
  defaultSubtitleStyle,
  SubtitlePanel,
  type PanelTab,
  type SubtitleStyle,
} from "./subtitle-panel";

const track = (id: number, lang: string, fields: Partial<Track> = {}): Track => ({
  id,
  type: "sub",
  title: "",
  lang,
  codec: "subrip",
  default: false,
  selected: false,
  secondary: false,
  external: false,
  forced: false,
  hearingImpaired: false,
  ...fields,
});

function renderPanel(
  options: {
    tracks?: Track[];
    subtitleId?: number;
    secondaryId?: number;
    tab?: PanelTab;
    unsaved?: boolean;
  } = {},
) {
  const tracks = options.tracks ?? [
    track(1, "en", { selected: true }),
    track(2, "ja"),
    track(3, "fr", { codec: "hdmv_pgs_subtitle" }),
  ];
  const props = {
    onPickTrack: vi.fn<(id: number) => void>(),
    onPickSecondaryTrack: vi.fn<(id: number) => void>(),
    onPickSecondaryAddon: vi.fn<(subtitle: AddonSubtitle) => void>(),
    onSave: vi.fn<() => void>(),
    onTabChange: vi.fn<(tab: PanelTab) => void>(),
    onClose: vi.fn<() => void>(),
  };
  render(
    <SubtitlePanel
      open
      tab={options.tab ?? "subtitles"}
      onTabChange={props.onTabChange}
      onClose={props.onClose}
      subtitleTracks={tracks}
      addedIds={new Set()}
      subtitleId={options.subtitleId ?? 1}
      onPickTrack={props.onPickTrack}
      addonSubtitles={[]}
      addonLoading={false}
      addonKey={undefined}
      loadingKey={undefined}
      onPickAddon={vi.fn<(subtitle: AddonSubtitle) => void>()}
      secondaryId={options.secondaryId ?? 0}
      secondaryAddonKey={undefined}
      onPickSecondaryTrack={props.onPickSecondaryTrack}
      onPickSecondaryAddon={props.onPickSecondaryAddon}
      preferredLanguage="en"
      audioTracks={[]}
      audioId={0}
      onPickAudio={vi.fn<(id: number) => void>()}
      style={defaultSubtitleStyle}
      onStyleChange={vi.fn<(style: SubtitleStyle) => void>()}
      save={{ unsaved: options.unsaved ?? false, onSave: props.onSave }}
      delay={0}
      onDelayChange={vi.fn<(delay: number) => void>()}
      position={0}
      subtitleText=""
    />,
  );
  return props;
}

describe("SubtitlePanel › second line", () => {
  it("offers a second line only when there is something to pair", () => {
    renderPanel({ tracks: [track(1, "en", { selected: true })] });
    expect(screen.queryByRole("button", { name: "Second line" })).toBeNull();
  });

  it("picks the main subtitles until asked for the second line", async () => {
    const { onPickTrack, onPickSecondaryTrack } = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: /^Japanese/ }));
    expect(onPickTrack).toHaveBeenCalledWith(2);
    expect(onPickSecondaryTrack).not.toHaveBeenCalled();
  });

  it("picks the second line from the same list", async () => {
    const { onPickTrack, onPickSecondaryTrack } = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Second line" }));
    await userEvent.click(screen.getByRole("button", { name: /^Japanese/ }));
    expect(onPickSecondaryTrack).toHaveBeenCalledWith(2);
    expect(onPickTrack).not.toHaveBeenCalled();
  });

  it("turns the second line off from Off", async () => {
    const { onPickSecondaryTrack } = renderPanel({ secondaryId: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Second line" }));
    expect(screen.getByRole("button", { name: /^Japanese/, pressed: true })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Off/ }));
    expect(onPickSecondaryTrack).toHaveBeenCalledWith(0);
  });

  it("won't repeat the main subtitles or use pictures as the second line", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Second line" }));
    const main = screen.getByRole("button", { name: /^English/ });
    expect(main).toHaveProperty("disabled", true);
    expect(main.textContent).toContain("Showing as the main subtitles");
    const pictures = screen.getByRole("button", { name: /^French/ });
    expect(pictures).toHaveProperty("disabled", true);
    expect(pictures.textContent).toContain("Pictures can’t be shown as a second line");
  });

  it("reaches every control by keyboard, each with a focus ring", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Second line" }));
    for (const element of keyboardReachable()) expect(hasFocusRing(element)).toBe(true);
  });
});

describe("SubtitlePanel › Style", () => {
  it("keeps a changed style as the profile's only when asked", async () => {
    const { onSave } = renderPanel({ tab: "style", unsaved: true });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Changes last until this video ends/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save as my style" }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("has nothing to save when the style is the saved one", () => {
    renderPanel({ tab: "style" });
    expect(screen.getByRole("button", { name: "Save as my style" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("This is your saved style.")).toBeTruthy();
  });

  it("reaches every control by keyboard, each with a focus ring", () => {
    renderPanel({ tab: "style", unsaved: true });
    for (const element of keyboardReachable()) expect(hasFocusRing(element)).toBe(true);
  });
});
