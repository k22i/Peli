import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { Service as Account } from "@bindings/account";
import type { Addon } from "@bindings/store";
import { Service as Store } from "@bindings/store";

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

// One change to a profile's list, for the addon manager (#38). Each is a
// single edit Go makes to the stored list, so the manager never writes back a
// list it read earlier, which could undo a pull that landed in between.
export type AddonEdit =
  | { kind: "install"; addon: Addon }
  | { kind: "remove"; url: string }
  | { kind: "move"; url: string; to: number }
  | { kind: "enable"; url: string; enabled: boolean };

// Edits a profile's addons. A kids profile's addons, or any while one is in
// use, need the parent PIN first (profileProblem in lib/account.ts explains
// the error codes, including addon_installed and addon_not_found).
export function useEditAddons(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: AddonEdit) => {
      if (edit.kind === "install") return Account.InstallAddon(profileId, edit.addon);
      if (edit.kind === "remove") return Account.RemoveAddon(profileId, edit.url);
      if (edit.kind === "move") return Account.MoveAddon(profileId, edit.url, edit.to);
      return Account.EnableAddon(profileId, edit.url, edit.enabled);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: addonsQuery(profileId).queryKey }),
  });
}
