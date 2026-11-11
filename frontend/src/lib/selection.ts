// The Library's multi-select (⌘/Ctrl-click, Shift-click, ⌘A, Esc). Selections
// are sets of the grid's own keys, kept in the grid's order by the caller.

// The keys from `anchor` to `target` in `keys`, either way round, both ends
// included. Without a usable anchor it is just the target.
export function selectRange(keys: readonly string[], anchor: string | undefined, target: string) {
  const from = anchor === undefined ? -1 : keys.indexOf(anchor);
  const to = keys.indexOf(target);
  if (to < 0) return [];
  if (from < 0) return [target];
  return keys.slice(Math.min(from, to), Math.max(from, to) + 1);
}

export function toggleKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(key)) next.add(key);
  return next;
}

// What a click does while the selection is being built: ⌘/Ctrl toggles one,
// Shift takes the range from the anchor (added to what is selected, as in
// Finder), and a plain click toggles too once something is selected.
export type ClickKind = "toggle" | "range" | "open";

export function clickKind(
  event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  selecting: boolean,
): ClickKind {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey || selecting) return "toggle";
  return "open";
}
