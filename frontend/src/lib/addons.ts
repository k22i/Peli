import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { Service as Account } from "@bindings/account";
import type { Addon } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import { addonBase, manifestUrl } from "@/lib/addon-protocol";

// A profile's installed addons, in order, from the local store (#32). Go
// keeps the list in sync with Nuvio: a pull that changes it refreshes this
// query (its key sits under "addons" in lib/sync.ts), and an edit here is
// pushed by itself, merged with what other devices changed. Not persisted:
// the store is already on disk.
export const addonsQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["addons", profileId],
    queryFn: () => Store.Addons(profileId),
  });

// The enabled addons a profile may browse: all of them, or for a kids profile
// the ones its parent allowed (ADR-0014). Under the same key as the list, so
// an edit or a pull refreshes it too.
export const visibleAddonsQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["addons", profileId, "visible"],
    queryFn: async () => (await Store.VisibleAddons(profileId)) ?? [],
  });

// The manifest URL in what the user pasted to install an addon (#38): a
// manifest URL, an addon's base URL, a stremio:// link, or a link that names
// the addon in an `addon` parameter, as Stremio's web app's install links do.
// Undefined if it is none of those.
export function addonLink(input: string): string | undefined {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text.replace(/^stremio:\/\//i, "https://"));
  } catch {
    return undefined;
  }
  const named =
    url.searchParams.get("addon") ?? new URLSearchParams(url.hash.split("?")[1]).get("addon");
  if (named) return addonLink(named);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname === "") return undefined;
  return manifestUrl(text.replace(/^stremio:\/\//i, "https://"));
}

// The page where an addon is configured: Stremio's convention, next to the
// manifest. It gives back a new manifest URL with the config in its path.
export function configureUrl(url: string): string {
  return `${addonBase(url)}/configure`;
}

// One change to a profile's list, for the addon manager (#38). Each is a
// single edit Go makes to the stored list, so the manager never writes back a
// list it read earlier, which could undo a pull that landed in between.
export type AddonEdit =
  | { kind: "install"; addon: Addon }
  // Puts a removed addon back at index `at`: undo.
  | { kind: "insert"; addon: Addon; at: number }
  // Swaps the addon at `url` for `addon`, its reconfigured URL, in place.
  | { kind: "reconfigure"; url: string; addon: Addon }
  | { kind: "remove"; url: string }
  | { kind: "move"; url: string; to: number }
  | { kind: "enable"; url: string; enabled: boolean };

// The list after an edit, as Go makes it (internal/store/addons.go): shown at
// once, so the order catalogs and streams are asked in follows a move
// straight away. An edit Go would refuse leaves the list as it is.
export function applyAddonEdit(list: readonly Addon[], edit: AddonEdit): Addon[] {
  const out = [...list];
  if (edit.kind === "install" || edit.kind === "insert") {
    if (out.some((a) => a.url === edit.addon.url)) return out;
    out.splice(edit.kind === "install" ? out.length : clamp(edit.at, out.length), 0, edit.addon);
    return out;
  }
  const i = out.findIndex((a) => a.url === edit.url);
  if (i < 0) return out;
  const addon = out[i]!;
  if (edit.kind === "remove") {
    out.splice(i, 1);
  } else if (edit.kind === "move") {
    out.splice(i, 1);
    out.splice(clamp(edit.to, out.length), 0, addon);
  } else if (edit.kind === "enable") {
    out[i] = { ...addon, enabled: edit.enabled };
  } else if (edit.addon.url === edit.url || !out.some((a) => a.url === edit.addon.url)) {
    out[i] = { ...edit.addon, enabled: addon.enabled };
  }
  return out;
}

const clamp = (n: number, length: number) => Math.min(Math.max(n, 0), length);

// Edits a profile's addons. Edits run one at a time, in order, and show in
// the list before Go has saved them; a refused one is rolled back. A kids
// profile's addons, or any while one is in use, need the parent PIN first
// (profileProblem in lib/account.ts explains the error codes, including
// addon_installed and addon_not_found).
export function useEditAddons(profileId: number) {
  const queryClient = useQueryClient();
  const { queryKey } = addonsQuery(profileId);
  return useMutation({
    scope: { id: `addons-${profileId}` },
    mutationFn: (edit: AddonEdit) => {
      if (edit.kind === "install") return Account.InstallAddon(profileId, edit.addon);
      if (edit.kind === "insert") return Account.InsertAddon(profileId, edit.addon, edit.at);
      if (edit.kind === "reconfigure") {
        return Account.ReconfigureAddon(profileId, edit.url, edit.addon);
      }
      if (edit.kind === "remove") return Account.RemoveAddon(profileId, edit.url);
      if (edit.kind === "move") return Account.MoveAddon(profileId, edit.url, edit.to);
      return Account.EnableAddon(profileId, edit.url, edit.enabled);
    },
    onMutate: async (edit) => {
      await queryClient.cancelQueries({ queryKey });
      const before = queryClient.getQueryData(queryKey);
      if (before) queryClient.setQueryData(queryKey, applyAddonEdit(before, edit));
      return { before };
    },
    onError: (_error, _edit, context) => {
      if (context?.before) queryClient.setQueryData(queryKey, context.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}
