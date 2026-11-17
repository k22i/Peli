import { queryOptions, useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import { Service as Store, type DeviceSettings, type ProfileSettings } from "@bindings/store";

// Settings live in the Go store (#17): a profile's follow the person
// (languages, subtitles), the device's follow the machine (hardware decoding,
// diagnostics). The theme stays in webview storage, since index.html reads it
// before first paint (lib/theme.ts).
export type { DeviceSettings, ProfileSettings };

export const subtitleSizes = ["small", "medium", "large"] as const;
export const captionsModes = ["system", "on", "off"] as const;

// What this device can show (#98, ADR-0048): the biggest picture to prefer,
// and whether HDR and Dolby Vision are wanted. "auto" for the resolution is no
// cap; for HDR it follows the display, and for Dolby Vision it is off, since a
// webview can't see it.
export const maxResolutions = ["auto", "2160p", "1080p", "720p"] as const;
export const displayModes = ["auto", "on", "off"] as const;
export type MaxResolution = (typeof maxResolutions)[number];
export type DisplayMode = (typeof displayModes)[number];

// A saved value this build doesn't know (or an older record's blank) is auto.
export function maxResolutionOf(
  device: Pick<DeviceSettings, "maxResolution"> | undefined,
): MaxResolution {
  return maxResolutions.find((value) => value === device?.maxResolution) ?? "auto";
}

export function displayModeOf(value: string | undefined): DisplayMode {
  return displayModes.find((mode) => mode === value) ?? "auto";
}

// The audio languages as a list: Go sends null for none until a profile saves.
export const audioLanguagesOf = (settings: ProfileSettings | undefined): string[] =>
  settings?.audioLanguages ?? [];

// The most audio languages a profile can list; the same cap as the store's.
export const audioLanguageLimit = 8;

// Adds a language at the end, unless it's listed already or the list is full.
export function addLanguage(list: readonly string[], code: string): string[] {
  if (!code || list.includes(code) || list.length >= audioLanguageLimit) return [...list];
  return [...list, code];
}

export const removeLanguage = (list: readonly string[], code: string): string[] =>
  list.filter((listed) => listed !== code);

// Moves a language one place earlier (-1) or later (1); the ends stay put.
export function moveLanguage(list: readonly string[], code: string, by: -1 | 1): string[] {
  const from = list.indexOf(code);
  const to = from + by;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  next.splice(from, 1);
  next.splice(to, 0, code);
  return next;
}

// Offered as audio and subtitle languages, as ISO 639-1 codes; "" is the
// stream's own default. mpv matches these against 2- and 3-letter tags.
export const languages = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "sv",
  "pl",
  "ru",
  "tr",
  "ar",
  "hi",
  "ja",
  "ko",
  "zh",
  "th",
  "vi",
  "id",
  "tl",
] as const;

export const profileSettingsQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["settings", "profile", profileId],
    queryFn: () => Store.ProfileSettings(profileId),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const deviceSettingsQuery = queryOptions({
  queryKey: ["settings", "device"],
  queryFn: () => Store.DeviceSettings(),
  staleTime: Number.POSITIVE_INFINITY,
});

// Saves a whole settings record, showing the change at once and undoing it if
// the save fails.
function useSaveSettings<T>(queryKey: QueryKey, save: (settings: T) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: save,
    onMutate: async (settings: T) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<T>(queryKey);
      queryClient.setQueryData(queryKey, settings);
      return { previous };
    },
    onError: (_error, _settings, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      toastManager.add({ type: "error", title: "Couldn’t save that setting" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

export function useSaveProfileSettings(profileId: number) {
  return useSaveSettings<ProfileSettings>(profileSettingsQuery(profileId).queryKey, (settings) =>
    Store.SaveProfileSettings(profileId, settings),
  );
}

export function useSaveDeviceSettings() {
  return useSaveSettings<DeviceSettings>(deviceSettingsQuery.queryKey, (settings) =>
    Store.SaveDeviceSettings(settings),
  );
}

// "en" or "eng" → "English", in the UI's language. Some locales write
// language names in lower case ("anglais", "inglés"); a name read from a code
// starts each word with a capital. A track's own title is not passed through here.
export function languageName(code: string, locale = navigator.language): string {
  try {
    const names = new Intl.DisplayNames([locale], { type: "language" });
    let name = names.of(code);
    // Some engines hand a code they don't know straight back; the
    // bibliographic ISO 639-2 ones ("fre", "ger") are the usual.
    if (!name || name.toLowerCase() === code.toLowerCase()) {
      const short = bibliographic[code.toLowerCase()];
      name = short ? names.of(short) : name;
    }
    return name && name.toLowerCase() !== code.toLowerCase() ? titleCase(name, locale) : code;
  } catch {
    return code;
  }
}

// ISO 639-2/B codes that differ from their 639-2/T ones, which engines know.
const bibliographic: Record<string, string> = {
  alb: "sq",
  arm: "hy",
  baq: "eu",
  bur: "my",
  chi: "zh",
  cze: "cs",
  dut: "nl",
  fre: "fr",
  geo: "ka",
  ger: "de",
  gre: "el",
  ice: "is",
  mac: "mk",
  mao: "mi",
  may: "ms",
  per: "fa",
  rum: "ro",
  slo: "sk",
  tib: "bo",
  wel: "cy",
};

function titleCase(text: string, locale: string): string {
  return text.replace(/(^|[\s(\-/])(\p{Ll})/gu, (_match, before: string, letter: string) => {
    return before + letter.toLocaleUpperCase(locale);
  });
}
