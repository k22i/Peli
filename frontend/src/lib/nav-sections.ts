import { useMemo } from "react";

import { useLiveTVAvailable } from "@/lib/livetv";
import { liveSection, sections, type Section } from "@/sections";

// Live TV (ADR-0066) joins the navs — the top capsule, the iPad sidebar and
// the tab bars — only while the profile may see it. `sections` itself stays
// the six: it is what ⌘1–6 index into, and the order those shortcuts keep.

// The sections with Live TV in its place, just before Library (the end when
// there's no Library).
export function withLive(list: readonly Section[], live: boolean): readonly Section[] {
  if (!live) return list;
  const before = list.findIndex((section) => section.to === "/library");
  if (before < 0) return [...list, liveSection];
  return [...list.slice(0, before), liveSection, ...list.slice(before)];
}

// The sections the navs show now.
export function useNavSections(): readonly Section[] {
  const available = useLiveTVAvailable();
  return useMemo(() => withLive(sections, available), [available]);
}
