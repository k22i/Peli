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

// Offered as default audio and subtitle languages, as ISO 639-1 codes; "" is
// the stream's own default. mpv matches these against 2- and 3-letter tags.
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

// "en" → "English", in the UI's language.
export function languageName(code: string, locale = navigator.language): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
