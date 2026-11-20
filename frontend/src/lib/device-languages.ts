import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { Service as Store } from "@bindings/store";

import { isIOS } from "@/lib/platform";
import { beforeProfile, currentProfileQuery } from "@/lib/profile";
import { profileSettingsQuery } from "@/lib/settings";

// The device's preferred languages as the 2- or 3-letter codes the audio
// language list holds, in order, each once: ["en-US", "fr-FR", "en-GB"] is
// ["en", "fr"].
export function deviceLanguageCodes(
  preferred: readonly string[] = navigator.languages ?? [navigator.language],
): string[] {
  const codes: string[] = [];
  for (const tag of preferred) {
    const code = tag.split(/[-_]/)[0]?.toLowerCase() ?? "";
    if (/^[a-z]{2,3}$/.test(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

// On iOS, the first time a local profile (the Guest, or one made here) is
// in use and has never saved settings, its audio languages become the
// device's, so a default-flagged dub (Russian, Hindi) doesn't start first.
// Go decides: a profile that syncs with Nuvio, or has saved anything, is left
// alone. Once per profile and run.
export function useSeedAudioLanguages() {
  const queryClient = useQueryClient();
  // Only on iOS, and not before a profile is in use: asking makes a Guest.
  const pathname = useLocation({ select: (location) => location.pathname });
  const { data } = useQuery({
    ...currentProfileQuery,
    enabled: isIOS() && !beforeProfile.has(pathname),
  });
  const tried = useRef(new Set<number>());
  const id = data?.id;

  useEffect(() => {
    if (!isIOS() || id === undefined || tried.current.has(id)) return;
    tried.current.add(id);
    const codes = deviceLanguageCodes();
    if (codes.length === 0) return;
    Store.SeedAudioLanguages(id, codes)
      .then((seeded) =>
        seeded
          ? queryClient.invalidateQueries({ queryKey: profileSettingsQuery(id).queryKey })
          : undefined,
      )
      .catch(() => {});
  }, [id, queryClient]);
}
