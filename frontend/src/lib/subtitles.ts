import { useQueries } from "@tanstack/react-query";

import {
  addonsFor,
  subtitlesQuery,
  type ContentType,
  type Extra,
  type Stream,
  type Subtitle,
} from "@/lib/addon-protocol";
import type { Track } from "@/lib/player";
import { languageName, type ProfileSettings } from "@/lib/settings";
import { useStreamAddons } from "@/lib/streams";

// Addon subtitles in the player (#63, ADR-0039): every enabled addon that
// serves subtitles for the video is asked once the file plays, and its
// answers are listed by language in the Subtitles menu. Picking one has Go
// download it and add it to mpv as an external track (Player.AddSubtitle).
// Like streams, they aren't limited for a kids profile (ADR-0014).

// What the player asks subtitle addons about: the video, and what's known of
// the file, which helps OpenSubtitles match a release. Subtitles the
// stream's own answer carried come first, under its addon's name.
export type SubtitleTarget = {
  type: ContentType;
  id: string;
  extra: Extra;
  stream?: { addon: string; subtitles: Subtitle[] } | undefined;
};

// The target for a stream picked for video id: Stremio sends the file's
// name, size and OpenSubtitles hash as extras when the stream gives them.
export function subtitleTarget(
  type: ContentType,
  id: string,
  stream: Stream,
  addon: string,
): SubtitleTarget {
  const hints = stream.behaviorHints;
  const known = {
    videoHash: hints?.videoHash,
    videoSize: hints?.videoSize,
    filename: hints?.filename,
  };
  const extra: Extra = Object.fromEntries(Object.entries(known).filter(([, value]) => value));
  return {
    type,
    id,
    extra,
    ...(stream.subtitles?.length && { stream: { addon, subtitles: stream.subtitles } }),
  };
}

// One addon subtitle file, as the menu lists it.
export type AddonSubtitle = {
  // Unique in the list: the addon and the file.
  key: string;
  url: string;
  // What it's grouped under: a language tag ("en", "pt-BR"), or the addon's
  // own code when it isn't one.
  language: string;
  // The ISO 639 code mpv and the profile take ("en", "pt"), or "".
  code: string;
  // The file's name, when the addon gives one.
  name: string;
  addon: string;
};

export type LanguageGroup = { language: string; label: string; subtitles: AddonSubtitle[] };

// Every addon's subtitles for target, in addon order, the stream's own
// first; `loading` until every addon has answered or failed. A failed addon
// is left out: the menu has no room to explain it, and others usually have
// the language.
export function useAddonSubtitles(
  profileId: number,
  target: SubtitleTarget | undefined,
): { subtitles: AddonSubtitle[]; loading: boolean } {
  const { addons, loading } = useStreamAddons(profileId);
  const asked = target ? addonsFor(addons, "subtitles", target.type, target.id) : [];
  const results = useQueries({
    queries: asked.map((addon) =>
      subtitlesQuery(addon.url, target!.type, target!.id, target!.extra),
    ),
  });
  const lists = [
    ...(target?.stream ? [{ key: "stream", ...target.stream }] : []),
    ...asked.map((addon, index) => ({
      key: addon.url,
      addon: addon.manifest.name,
      subtitles: results[index]?.data?.subtitles ?? [],
    })),
  ];
  const seen = new Set<string>();
  const subtitles = lists.flatMap(({ key, addon, subtitles: list }) =>
    list.flatMap((subtitle) => {
      if (seen.has(subtitle.url)) return [];
      seen.add(subtitle.url);
      return [
        {
          key: `${key} ${subtitle.id}`,
          url: subtitle.url,
          ...subtitleLanguage(subtitle.lang),
          name: fileName(subtitle),
          addon,
        },
      ];
    }),
  );
  return {
    subtitles,
    loading: Boolean(target) && (loading || results.some((result) => result.isPending)),
  };
}

// OpenSubtitles' own codes that aren't ISO 639.
const aliases: Record<string, string> = {
  pob: "pt-BR",
  pb: "pt-BR",
  zht: "zh-Hant",
  zhs: "zh-Hans",
  chs: "zh-Hans",
  cht: "zh-Hant",
};

// An addon's language ("eng", "pob", "Spanish") as a tag to group by and an
// ISO 639 code: "eng" is { language: "en", code: "en" }, "pob" is
// { language: "pt-BR", code: "pt" }.
export function subtitleLanguage(lang: string): { language: string; code: string } {
  const raw = lang.trim();
  try {
    const locale = new Intl.Locale(aliases[raw.toLowerCase()] ?? raw);
    if (locale.language === "und") return { language: "und", code: "" };
    return {
      language: locale.region || locale.script ? locale.baseName : locale.language,
      code: /^[a-z]{2,3}$/.test(locale.language) ? locale.language : "",
    };
  } catch {
    return { language: raw.toLowerCase(), code: "" };
  }
}

// A group's name in the menu.
export function languageLabel(language: string): string {
  return language === "und" ? "Unknown language" : languageName(language);
}

// The subtitles by language: the profile's language first (preferred, an
// ISO 639 code), then the rest by name. Within one, the addons' order, as
// OpenSubtitles puts its best match first.
export function byLanguage(subtitles: AddonSubtitle[], preferred: string): LanguageGroup[] {
  const groups = new Map<string, AddonSubtitle[]>();
  for (const subtitle of subtitles) {
    const group = groups.get(subtitle.language);
    if (group) group.push(subtitle);
    else groups.set(subtitle.language, [subtitle]);
  }
  const want = subtitleLanguage(preferred).code;
  const rank = (group: LanguageGroup) =>
    want && group.subtitles[0]!.code === want ? (group.language === want ? 0 : 1) : 2;
  return [...groups]
    .map(([language, list]) => ({ language, label: languageLabel(language), subtitles: list }))
    .toSorted((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

// The addon subtitles to show when a file starts: the first in the profile's
// language (preferred), when captions are on and the file has no full text
// subtitles in it. mpv picks the file's own when it has them (#62); a file
// whose only ones in that language are pictures (a Blu-ray's) gets the
// addon's text instead, which takes the profile's style.
export function autoSubtitle(
  subtitles: AddonSubtitle[],
  tracks: Track[],
  preferred: string,
  captions: boolean,
): AddonSubtitle | undefined {
  const want = subtitleLanguage(preferred).code;
  if (!captions || !want) return undefined;
  const own = tracks.some(
    (track) => isTextSubtitle(track) && !track.forced && subtitleLanguage(track.lang).code === want,
  );
  if (own) return undefined;
  return byLanguage(subtitles, want)[0]?.subtitles.find((subtitle) => subtitle.code === want);
}

// Subtitle codecs that are pictures (Blu-ray, DVD): there is no text in them
// to draw as a second line.
const pictureCodecs = new Set([
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "dvb_subtitle",
  "dvb_teletext",
  "xsub",
]);

// Whether a track is subtitles made of text, which the second line can show.
export const isTextSubtitle = (track: Track): boolean =>
  track.type === "sub" && !pictureCodecs.has(track.codec);

// Whether a track is subtitles made of pictures (Blu-ray, DVD): drawn as they
// were made, since no style reaches a picture.
export const isPictureSubtitle = (track: Track): boolean =>
  track.type === "sub" && pictureCodecs.has(track.codec);

// Whether a track is styled text (ASS/SSA, as anime and some films bring):
// Restyle gives it the profile's font, size, colour, edge and position, but
// colours or italics set on single words and positioned signs keep their
// own look, and Bold doesn't reach it.
export const isStyledSubtitle = (track: Track): boolean =>
  track.type === "sub" && (track.codec === "ass" || track.codec === "ssa");

// Text subtitles to show instead of a picture track, which can't take the
// profile's style: the file's own full text track in its language (as
// hearing-impaired as it, then the default-flagged one), else an addon's.
// Nothing for a text track, a forced one (signs), or one with no language.
export function textInstead(
  track: Track,
  tracks: Track[],
  subtitles: AddonSubtitle[],
): { track: Track } | { addon: AddonSubtitle } | undefined {
  const want = subtitleLanguage(track.lang).code;
  if (!isPictureSubtitle(track) || track.forced || !want) return undefined;
  const own = tracks
    .filter(
      (each) => isTextSubtitle(each) && !each.forced && subtitleLanguage(each.lang).code === want,
    )
    .toSorted(
      (a, b) =>
        Number(a.hearingImpaired !== track.hearingImpaired) -
          Number(b.hearingImpaired !== track.hearingImpaired) ||
        Number(!a.default) - Number(!b.default),
    )[0];
  if (own) return { track: own };
  const addon = byLanguage(subtitles, want)[0]?.subtitles.find((each) => each.code === want);
  return addon && { addon };
}

// The tracks the second line can show: text, and not the one showing as the
// main subtitles.
export const secondChoices = (tracks: Track[], mainId: number): Track[] =>
  tracks.filter((track) => isTextSubtitle(track) && track.id !== mainId);

// What to show as the second line when a file starts, in the profile's second
// language: one of the file's own text tracks, or else an addon's. Nothing
// when the main subtitles are off or only forced (signs), or are in that
// language already, or when none of them has it.
export function autoSecondary(
  tracks: Track[],
  subtitles: AddonSubtitle[],
  second: string,
  mainId: number,
): { track: Track } | { addon: AddonSubtitle } | undefined {
  const want = subtitleLanguage(second).code;
  const main = tracks.find((track) => track.type === "sub" && track.id === mainId);
  if (!want || !main || main.forced || subtitleLanguage(main.lang).code === want) return undefined;
  const own = secondChoices(tracks, mainId).find(
    (track) => !track.forced && subtitleLanguage(track.lang).code === want,
  );
  if (own) return { track: own };
  const addon = byLanguage(subtitles, want)[0]?.subtitles.find((each) => each.code === want);
  return addon && { addon };
}

// The language subtitles should be in: the profile's subtitle language, else
// its first audio language, else the system's (navigator.language), else
// English. The profile's own choice can be empty, and a device whose
// subtitles are always on still needs one to look for.
export function wantedSubtitleLanguage(
  settings: Pick<ProfileSettings, "subtitleLanguage" | "audioLanguages"> | undefined,
): string {
  const wanted = [
    settings?.subtitleLanguage ?? "",
    settings?.audioLanguages?.[0] ?? "",
    navigator.language,
    "en",
  ];
  for (const lang of wanted) {
    const code = subtitleLanguage(lang).code;
    if (code) return code;
  }
  return "";
}

// What to show when a file starts with subtitles always on: the file's own
// full text track in the wanted language (not hearing-impaired over
// hearing-impaired, the default-flagged one first), else an addon's in that
// language, else the file's own picture track in it (a Blu-ray's, which
// the style can't reach), else the file's only full track when it has
// exactly one with no language tag. Forced tracks (signs) never count.
export function smartSubtitle(
  tracks: Track[],
  subtitles: AddonSubtitle[],
  want: string,
): { track: Track } | { addon: AddonSubtitle } | undefined {
  const full = tracks.filter((track) => track.type === "sub" && !track.forced);
  if (want) {
    const own = full
      .filter((track) => subtitleLanguage(track.lang).code === want)
      .toSorted(
        (a, b) =>
          Number(!isTextSubtitle(a)) - Number(!isTextSubtitle(b)) ||
          Number(a.hearingImpaired) - Number(b.hearingImpaired) ||
          Number(!a.default) - Number(!b.default),
      )[0];
    if (own && isTextSubtitle(own)) return { track: own };
    const addon = byLanguage(subtitles, want)[0]?.subtitles.find((each) => each.code === want);
    if (addon) return { addon };
    if (own) return { track: own };
  }
  // A file that tags none of its tracks has only the one to show.
  const untagged = full.filter((track) => !track.lang || track.lang === "und");
  return untagged.length === 1 ? { track: untagged[0]! } : undefined;
}

function fileName(subtitle: Subtitle): string {
  for (const field of ["subtitleFileName", "fileName", "filename", "title", "name"]) {
    const value = subtitle[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// How Go lined an addon's subtitles up with the video (Player.SubtitleSync,
// Subtitle.autoSync): status "synced", "inSync", "noMatch", "noReference",
// "unchecked", or "" when not tried. Shifts in seconds, later positive.
export type SubtitleSync = { status: string; firstShift: number; lastShift: number };

// "2.4 s later", "0.8 s earlier".
function moved(by: number): string {
  return `${Math.abs(by).toFixed(1)} s ${by > 0 ? "later" : "earlier"}`;
}

// What the panel says about it, or nothing for a track that wasn't tried.
export function syncSummary(
  sync: SubtitleSync | undefined,
): { title: string; detail: string; synced: boolean } | undefined {
  switch (sync?.status) {
    case "synced": {
      // A frame-rate fix moves the end further than the start.
      const stretched = Math.abs(sync.lastShift - sync.firstShift) >= 0.5;
      return {
        title: "Synced to this video",
        detail: stretched
          ? `Moved ${moved(sync.firstShift)} at the start and ${moved(sync.lastShift)} by the end: they were made for another frame rate.`
          : `Moved ${moved(sync.firstShift)}, to match the subtitles this video comes with.`,
        synced: true,
      };
    }
    case "inSync":
      return {
        title: "Already in sync",
        detail: "Checked against the subtitles this video comes with.",
        synced: false,
      };
    case "noMatch":
      return {
        title: "Couldn’t sync these",
        detail:
          "They don’t line up with the subtitles this video comes with, so they keep the addon’s timing. They may be for another cut.",
        synced: false,
      };
    case "noReference":
      return {
        title: "Not synced",
        detail: "This video has no subtitles of its own to line them up with.",
        synced: false,
      };
    case "unchecked":
      return {
        title: "Not synced",
        detail: "This video’s own subtitles couldn’t be read in time.",
        synced: false,
      };
    default:
      return undefined;
  }
}
