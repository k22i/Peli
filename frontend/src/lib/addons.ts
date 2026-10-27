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

// Where an addon's manifest is. Lists synced from Nuvio hold some addons by
// their base URL ("https://opensubtitles-v3.strem.io"), Stremio by the
// manifest's, and links may use stremio://.
export function manifestUrl(url: string): string {
  const https = url.replace(/^stremio:\/\//, "https://");
  return https.endsWith("/manifest.json") ? https : `${https.replace(/\/+$/, "")}/manifest.json`;
}

// What the addon list shows of a manifest. The typed client (#37) reads the
// rest.
export type ManifestSummary = {
  id: string;
  name: string;
  version: string;
  description?: string;
};

export class ManifestError extends Error {}

const manifestTimeout = 15_000;

async function fetchManifest(url: string, signal: AbortSignal): Promise<ManifestSummary> {
  let response: Response;
  try {
    response = await fetch(manifestUrl(url), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(manifestTimeout)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ManifestError(
      error instanceof DOMException && error.name === "TimeoutError"
        ? "The addon didn’t answer."
        : "The addon couldn’t be reached.",
    );
  }
  if (!response.ok) throw new ManifestError(`The addon answered ${response.status}.`);
  const manifest: unknown = await response.json().catch(() => undefined);
  if (!isManifest(manifest)) throw new ManifestError("That isn’t an addon manifest.");
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(typeof manifest.description === "string" && { description: manifest.description }),
  };
}

function isManifest(value: unknown): value is ManifestSummary & { description?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "version" in value &&
    typeof value.version === "string"
  );
}

// An installed addon's manifest. One that fails to load is shown with its
// error and stays installed: dropping it would delete it on every device at
// the next push (#32).
export const manifestQuery = (url: string) =>
  queryOptions({
    queryKey: ["addon-manifest", url],
    queryFn: ({ signal }) => fetchManifest(url, signal),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
