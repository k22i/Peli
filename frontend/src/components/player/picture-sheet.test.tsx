import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { presetPicture, standardPicture, type Picture } from "@/lib/picture";
import { hasFocusRing, keyboardReachable } from "@/test/focus";

import { PictureSheet } from "./picture-sheet";

function renderSheet(changes: Partial<Parameters<typeof PictureSheet>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn<() => void>(),
    title: "Dune: Part Two",
    picture: standardPicture,
    presets: [],
    ownPicture: false,
    saves: true,
    onPreview: vi.fn<(picture: Picture) => void>(),
    onChange: vi.fn<(picture: Picture) => void>(),
    onReset: vi.fn<() => void>(),
    onUseForAll: vi.fn<() => void>(),
    onSavePreset: vi.fn<(name: string) => void>(),
    ...changes,
  };
  render(<PictureSheet {...props} />);
  return props;
}

describe("PictureSheet", () => {
  it("picks a preset and says whom the change is kept for", async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Vivid" }));
    expect(props.onChange).toHaveBeenCalledWith(presetPicture("vivid"));
    expect(screen.getByText("Changes here are kept for Dune: Part Two.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Standard", pressed: true })).toBeTruthy();
  });

  it("moves a value with the keyboard, which keeps it", async () => {
    const props = renderSheet();
    screen.getByRole("slider", { name: "Contrast" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(props.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ preset: "custom", contrast: 1 }),
    );
  });

  it("resets only a title with its own picture", async () => {
    renderSheet();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    const props = renderSheet({ ownPicture: true });
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(props.onReset).toHaveBeenCalled();
  });

  it("saves the values as a named preset", async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Save as preset…" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Preset name" }), "Night{Enter}");
    expect(props.onSavePreset).toHaveBeenCalledWith("Night");
  });

  it("closes on Escape, and gives every control a focus ring", async () => {
    const props = renderSheet();
    for (const element of keyboardReachable()) expect(hasFocusRing(element)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("says a file nothing names keeps its changes until it ends", () => {
    renderSheet({ saves: false });
    expect(screen.getByText("Changes here last until this video ends.")).toBeTruthy();
  });
});
