import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { defaultFraming, type Framing } from "@/lib/framing";
import { presetPicture, standardPicture, type Picture } from "@/lib/picture";
import { defaultQuality, type Quality } from "@/lib/quality";
import { hasFocusRing, keyboardReachable } from "@/test/focus";

import { PictureSheet, type PictureSheetTab } from "./picture-sheet";

function renderSheet(
  options: {
    tab?: PictureSheetTab;
    saves?: boolean;
    ownPicture?: boolean;
    framing?: Framing;
  } = {},
) {
  const picture = {
    picture: standardPicture,
    presets: [],
    own: options.ownPicture ?? false,
    onPreview: vi.fn<(picture: Picture) => void>(),
    onChange: vi.fn<(picture: Picture) => void>(),
    onReset: vi.fn<() => void>(),
    onUseForAll: vi.fn<() => void>(),
    onSavePreset: vi.fn<(name: string) => void>(),
  };
  const framing = {
    framing: options.framing ?? defaultFraming,
    own: false,
    found: undefined,
    onPreview: vi.fn<(framing: Framing) => void>(),
    onChange: vi.fn<(framing: Framing) => void>(),
    onReset: vi.fn<() => void>(),
    onUseForAll: vi.fn<() => void>(),
  };
  const quality = {
    quality: defaultQuality,
    own: false,
    hdrShown: false,
    onPreview: vi.fn<(quality: Quality) => void>(),
    onChange: vi.fn<(quality: Quality) => void>(),
    onReset: vi.fn<() => void>(),
    onUseForAll: vi.fn<() => void>(),
  };
  const onClose = vi.fn<() => void>();
  const onTabChange = vi.fn<(tab: PictureSheetTab) => void>();
  render(
    <PictureSheet
      open
      onClose={onClose}
      tab={options.tab ?? "picture"}
      onTabChange={onTabChange}
      title="Dune: Part Two"
      saves={options.saves ?? true}
      picture={picture}
      framing={framing}
      quality={quality}
    />,
  );
  return { picture, framing, quality, onClose, onTabChange };
}

describe("PictureSheet", () => {
  it("picks a preset and says whom the change is kept for", async () => {
    const { picture } = renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Vivid" }));
    expect(picture.onChange).toHaveBeenCalledWith(presetPicture("vivid"));
    expect(screen.getByText("Changes here are kept for Dune: Part Two.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Standard", pressed: true })).toBeTruthy();
  });

  it("moves a value with the keyboard, which keeps it", async () => {
    const { picture } = renderSheet();
    screen.getByRole("slider", { name: "Contrast" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(picture.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ preset: "custom", contrast: 1 }),
    );
  });

  it("resets only a title with its own picture", async () => {
    renderSheet();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("resets a title's own picture", async () => {
    const { picture } = renderSheet({ ownPicture: true });
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(picture.onReset).toHaveBeenCalled();
  });

  it("saves the values as a named preset", async () => {
    const { picture } = renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Save as preset…" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Preset name" }), "Night{Enter}");
    expect(picture.onSavePreset).toHaveBeenCalledWith("Night");
  });

  it("closes on Escape, and gives every control a focus ring", async () => {
    const { onClose } = renderSheet();
    for (const element of keyboardReachable()) expect(hasFocusRing(element)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("says a file nothing names keeps its changes until it ends", () => {
    renderSheet({ saves: false });
    expect(screen.getByText("Changes here last until this video ends.")).toBeTruthy();
  });

  it("switches tabs", async () => {
    const { onTabChange } = renderSheet();
    await userEvent.click(screen.getByRole("tab", { name: "Framing" }));
    expect(onTabChange).toHaveBeenCalledWith("framing");
  });
});

describe("Framing tab", () => {
  it("fits, sets an aspect ratio, and takes a custom one", async () => {
    const { framing } = renderSheet({ tab: "framing" });
    await userEvent.click(screen.getByRole("button", { name: "Fill" }));
    expect(framing.onChange).toHaveBeenLastCalledWith({ ...defaultFraming, fit: "fill" });
    await userEvent.click(screen.getByRole("button", { name: "2.39" }));
    expect(framing.onChange).toHaveBeenLastCalledWith({ ...defaultFraming, aspect: "2.39:1" });
    await userEvent.click(screen.getByRole("button", { name: "Custom…" }));
    const field = screen.getByRole("textbox", { name: "Custom aspect ratio" });
    await userEvent.type(field, "wide{Enter}");
    expect(framing.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ aspect: "wide" }));
    await userEvent.clear(field);
    await userEvent.type(field, "2.76:1{Enter}");
    expect(framing.onChange).toHaveBeenLastCalledWith({ ...defaultFraming, aspect: "2.76:1" });
  });

  it("shows the pan sliders only while zoomed, and the crop edges only by hand", () => {
    renderSheet({ tab: "framing" });
    expect(screen.queryByRole("slider", { name: "Move left or right" })).toBeNull();
    expect(screen.getByRole("slider", { name: "Crop top" })).toBeTruthy();
  });

  it("hides the crop edges while black bars are removed for it", () => {
    renderSheet({ tab: "framing", framing: { ...defaultFraming, autoCrop: true, zoom: 1 } });
    expect(screen.queryByRole("slider", { name: "Crop top" })).toBeNull();
    expect(screen.getByRole("slider", { name: "Move left or right" })).toBeTruthy();
    expect(screen.getByText("Looking for bars as it plays…")).toBeTruthy();
  });

  it("rotates and mirrors", async () => {
    const { framing } = renderSheet({ tab: "framing" });
    await userEvent.click(screen.getByRole("button", { name: "90°" }));
    expect(framing.onChange).toHaveBeenLastCalledWith({ ...defaultFraming, rotate: 90 });
    await userEvent.click(screen.getByRole("switch", { name: /Mirror/ }));
    expect(framing.onChange).toHaveBeenLastCalledWith({ ...defaultFraming, flipH: true });
  });
});

describe("Quality tab", () => {
  it("sets scaling, debanding and the upscaler, and warns about a heavy mix", async () => {
    const { quality } = renderSheet({ tab: "quality" });
    const scaling = screen.getByRole("group", { name: "Scaling" });
    await userEvent.click(within(scaling).getByRole("button", { name: "High" }));
    expect(quality.onChange).toHaveBeenLastCalledWith({ ...defaultQuality, scaling: "high" });
    await userEvent.click(screen.getByRole("button", { name: "Anime4K" }));
    expect(quality.onChange).toHaveBeenLastCalledWith({ ...defaultQuality, upscaler: "anime4k" });
    await userEvent.click(screen.getByRole("switch", { name: /Motion smoothing/ }));
    expect(quality.onChange).toHaveBeenLastCalledWith({ ...defaultQuality, motionSmoothing: true });
  });

  it("says on the device's button what it does", () => {
    renderSheet({ tab: "quality" });
    expect(screen.getByRole("button", { name: "Use on this device" })).toBeTruthy();
  });
});
