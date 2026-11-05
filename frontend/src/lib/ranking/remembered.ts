import type { Resolution } from "./parse";
import { collapsedTiers, resolutionOrder, type Candidate } from "./score";

// The source a profile last played a show from (#58, F19), as a
// fingerprint: the addon (or plugin) it came from, its quality and its
// release group. The next episode's streams are other files, so the
// fingerprint is what carries over: the same group from the same addon
// usually means the same encode, audio and subtitles as the last episode.
export type Remembered = {
  // The source's key: the addon's URL, or a plugin's pluginSource.
  source: string;
  // As the parser reads it ("1080p"), or null when the stream didn't say.
  resolution: string | null;
  group: string | null;
};

// How well a candidate matches: the quality must, and then the group or
// the addon too. 0 for no match. The addon counts when any copy of the file
// came from it.
export function rememberedMatch(remembered: Remembered, c: Candidate): number {
  if (c.parsed.resolution !== remembered.resolution) return 0;
  const group =
    remembered.group !== null &&
    c.parsed.group !== null &&
    c.parsed.group.toLowerCase() === remembered.group.toLowerCase();
  const source =
    c.source === remembered.source || c.alternates.some((a) => a.source === remembered.source);
  if (!group && !source) return 0;
  return (group ? 2 : 0) + (source ? 1 : 0);
}

// The best match in `sorted` (ranked best first): the closest match, the
// higher-ranked of equals. Never a likely fake or CAM, never one above the
// device's resolution cap (#98), and never one that needs a debrid download
// when the ranked best doesn't. null for none, when the ranked best is the
// pick.
export function rememberedPick(
  remembered: Remembered,
  sorted: readonly Candidate[],
  best: Candidate | null,
  maxResolution: Resolution = "2160p",
): Candidate | null {
  const cap = resolutionOrder.indexOf(maxResolution);
  let pick: Candidate | null = null;
  let level = 0;
  for (const c of sorted) {
    if (collapsedTiers.has(c.tier)) continue;
    if (c.parsed.resolution && resolutionOrder.indexOf(c.parsed.resolution) > cap) continue;
    if (c.parsed.cached === false && best?.parsed.cached !== false) continue;
    const match = rememberedMatch(remembered, c);
    if (match > level) {
      pick = c;
      level = match;
      if (level === 3) break;
    }
  }
  return pick;
}
