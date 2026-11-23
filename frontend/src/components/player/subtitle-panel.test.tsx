import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Track } from "@/lib/player";
import { subtitleLanguage, type AddonSubtitle } from "@/lib/subtitles";
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
    addons?: AddonSubtitle[];
  } = {},
) {
  const tracks = options.tracks ?? [
    track(1, "en", { selected: true }),
    track(2, "ja"),
    track(3, "fr", { codec: "hdmv_pgs_subtitle" }),
  ];
  const props = {
    onPickTrack: vi.fn<(id: number) => void>(),
    onPickAddon: vi.fn<(subtitle: AddonSubtitle) => void>(),
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
      addonSubtitles={options.addons ?? []}
      addonLoading={false}
      addonKey={undefined}
      loadingKey={undefined}
      onPickAddon={props.onPickAddon}
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

// A language has a filter chip (in the Languages fieldset) and a row in the
// list, both named for it; this is the row.
function row(name: RegExp) {
  const [found, ...rest] = screen
    .getAllByRole("button", { name })
    .filter((button) => !button.closest("fieldset"));
  if (!found || rest.length > 0) throw new Error(`Expected one row named ${String(name)}`);
  return found;
}

describe("SubtitlePanel › second line", () => {
  it("offers a second line only when there is something to pair", () => {
    renderPanel({ tracks: [track(1, "en", { selected: true })] });
    expect(screen.queryByRole("button", { name: "Second line" })).toBeNull();
  });

  it("picks the main subtitles until asked for the second line", async () => {
    const { onPickTrack, onPickSecondaryTrack } = renderPanel();
    await userEvent.click(row(/^Japanese/));
    expect(onPickTrack).toHaveBeenCalledWith(2);
    expect(onPickSecondaryTrack).not.toHaveBeenCalled();
  });

  it("picks the second line from the same list", async () => {
    const { onPickTrack, onPickSecondaryTrack } = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Second line" }));
    await userEvent.click(row(/^Japanese/));
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
    const main = row(/^English/);
    expect(main).toHaveProperty("disabled", true);
    expect(main.textContent).toContain("Showing as the main subtitles");
    const pictures = row(/^French/);
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

describe("SubtitlePanel › picture subtitles", () => {
  const pictures = [
    track(1, "en", { selected: true }),
    track(3, "fr", { codec: "hdmv_pgs_subtitle", hearingImpaired: true }),
  ];
  const addon: AddonSubtitle = {
    key: "fr1",
    url: "https://subs.example/fr1.srt",
    ...subtitleLanguage("fre"),
    name: "",
    addon: "OpenSubtitles v3",
  };

  it("marks a picture track in the list", () => {
    renderPanel({ tracks: pictures });
    expect(row(/^French/).textContent).toContain("Image");
    expect(row(/^English/).textContent).not.toContain("Image");
  });

  it("says the style can't reach pictures, and offers the file's text track", async () => {
    const tracks = [...pictures, track(4, "fr")];
    const { onPickTrack } = renderPanel({ tracks, subtitleId: 3, tab: "style" });
    expect(screen.getByRole("region", { name: "Picture subtitles" }).textContent).toContain(
      "These French subtitles are pictures",
    );
    await userEvent.click(screen.getByRole("button", { name: "Use the text track in this file" }));
    expect(onPickTrack).toHaveBeenCalledWith(4);
  });

  it("offers an addon's text when the file has none", async () => {
    const { onPickAddon } = renderPanel({
      tracks: pictures,
      subtitleId: 3,
      tab: "style",
      addons: [addon],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Use OpenSubtitles v3’s text subtitles" }),
    );
    expect(onPickAddon).toHaveBeenCalledWith(addon);
  });

  it("says nothing for text subtitles, and offers nothing without text", () => {
    renderPanel({ tracks: pictures, subtitleId: 1, tab: "style" });
    expect(screen.queryByRole("region", { name: "Picture subtitles" })).toBeNull();
    renderPanel({ tracks: pictures, subtitleId: 3, tab: "style" });
    expect(screen.getByRole("region", { name: "Picture subtitles" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });
});
