import { Service as Shell } from "@bindings/shell";
import { Events } from "@wailsio/runtime";
import { useSyncExternalStore } from "react";

import { isIOS } from "@/lib/platform";

// What the iPad has attached besides its screen (#138): a hardware keyboard
// (Go's GCKeyboard watch, internal/shell) and a pointer (a trackpad or a
// mouse). The desktop shortcuts, the command palette and the player's
// volume slider follow them live. Off iOS both stay false: the desktop has
// its controls anyway (lib/features.ts).
const state = { keyboard: false, pointer: false };
// The last pointer down's type, for a right-click that should open a
// popover rather than a sheet (ResponsiveContextMenu).
let lastPointer = "";
const listeners = new Set<() => void>();

function set(next: Partial<typeof state>) {
  const keyboard = next.keyboard ?? state.keyboard;
  const pointer = next.pointer ?? state.pointer;
  if (keyboard === state.keyboard && pointer === state.pointer) return;
  state.keyboard = keyboard;
  state.pointer = pointer;
  for (const listener of listeners) listener();
}

function onPointerDown(event: PointerEvent) {
  lastPointer = event.pointerType;
  if (event.pointerType === "mouse") set({ pointer: true });
}

// Hover alone (no press) moves a mouse-type pointer too.
function onPointerMove(event: PointerEvent) {
  if (event.pointerType === "mouse") set({ pointer: true });
}

export function subscribeInputDevices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const hardwareKeyboard = (): boolean => state.keyboard;
export const pointerAttached = (): boolean => state.pointer;
export const lastPointerType = (): string => lastPointer;

// Starts watching, once, at startup on iOS. Returns a stop for tests.
export function startInputDevices(): () => void {
  if (!isIOS()) return () => {};
  const stops: (() => void)[] = [];
  Shell.HardwareKeyboard()
    .then((attached) => set({ keyboard: attached }))
    .catch(() => {});
  stops.push(Events.On("shell:keyboard", (event) => set({ keyboard: event.data.attached })));

  // WebKit on iPadOS answers any-pointer: fine while a trackpad or mouse is
  // connected; a mouse-type pointer event says so too, where it doesn't.
  const fine = typeof matchMedia === "function" ? matchMedia("(any-pointer: fine)") : undefined;
  if (fine) {
    set({ pointer: fine.matches });
    const onChange = () => set({ pointer: fine.matches });
    fine.addEventListener("change", onChange);
    stops.push(() => fine.removeEventListener("change", onChange));
  }
  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  stops.push(() => {
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("pointermove", onPointerMove, { capture: true });
  });
  return () => {
    for (const stop of stops) stop();
  };
}

export function useHardwareKeyboard(): boolean {
  return useSyncExternalStore(subscribeInputDevices, hardwareKeyboard, () => false);
}

export function usePointerAttached(): boolean {
  return useSyncExternalStore(subscribeInputDevices, pointerAttached, () => false);
}
