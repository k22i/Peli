import { searchTerm } from "@/lib/search";

// The command palette's rules, apart from its view.

// Ctrl/⌘+K, with nothing else held. Someone else's handler that already took
// the key (a text field with its own ⌘K) wins, so the palette never steals it.
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.shiftKey) return false;
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
}

// Whether a command answers what's typed: every word of the query is the
// start of a word in its label or keywords, so "set pl" finds "Settings:
// Playback".
export function commandMatches(label: string, keywords: string, query: string): boolean {
  const words = `${label} ${keywords}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => words.some((word) => word.startsWith(part)));
}

// How many titles of one kind the palette lists; Search has the rest.
export const titlesPerGroup = 5;

// How many recently watched titles show before anything is typed.
export const recentCount = 5;

// What the palette sends to search: the same rule as the Search page.
export const paletteTerm = searchTerm;

// The newest `recentCount` of the titles with a watched time, newest first.
export function recentTitles<T extends { contentId: string }>(
  items: readonly T[],
  lastWatched: Readonly<Record<string, number | undefined>>,
): T[] {
  return items
    .filter((item) => (lastWatched[item.contentId] ?? 0) > 0)
    .toSorted((a, b) => (lastWatched[b.contentId] ?? 0) - (lastWatched[a.contentId] ?? 0))
    .slice(0, recentCount);
}
