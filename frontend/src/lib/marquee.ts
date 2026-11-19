// Home's marquee (the rotating hero): the step a key pages it by while focus
// is in it. -1 for ←, 1 for →, else 0: another key, a modifier held, or one
// title only. A text field keeps its arrows.
export function heroArrowStep(
  event: Pick<
    KeyboardEvent,
    "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "defaultPrevented"
  > & { target: EventTarget | null },
  count: number,
): -1 | 0 | 1 {
  if (count < 2 || event.defaultPrevented) return 0;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0;
  const { target } = event;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) {
    return 0;
  }
  return event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
}
