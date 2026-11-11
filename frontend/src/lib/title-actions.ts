import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { LibraryItem, Progress, WatchedItem } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import { toastManager } from "@/components/ui/toast";
import type { Meta } from "@/lib/addon-protocol";
import {
  seriesMarkChange,
  isSeriesType,
  titleMark,
  titleState,
  type TitlePreview,
} from "@/lib/title";

// What a title's context menu (components/media/title-menu.tsx) needs to
// know about a card: the preview the title page paints from, and its IMDb id
// when the card's source gave one. Everything else (details, watched state,
// the library) the menu reads when it opens.
export type MenuTitle = TitlePreview & { imdbId?: string | undefined };

// The menu's title for a catalog or search entry.
export function menuTitle(meta: {
  id: string;
  type: TitlePreview["type"];
  name: string;
  poster?: string | undefined;
  background?: string | undefined;
  releaseInfo?: string | undefined;
  description?: string | undefined;
  imdb_id?: unknown;
}): MenuTitle {
  const { imdb_id: imdb, ...preview } = meta;
  const imdbId = typeof imdb === "string" ? imdb : undefined;
  return { ...preview, ...(imdbId ? { imdbId } : {}) };
}

// The menu's title for a library entry.
export const libraryMenuTitle = (item: LibraryItem): MenuTitle => ({
  id: item.contentId,
  type: item.contentType,
  name: item.name,
  poster: item.poster ?? undefined,
  background: item.background ?? undefined,
  releaseInfo: item.releaseInfo ?? undefined,
  description: item.description ?? undefined,
});

const imdbPattern = /^tt\d+$/;

// A title's IMDb id: its own id when it is one ("tt0903747"), else the one
// the card or the details carry (Kitsu's entries have it in their meta).
export function imdbIdOf(title: MenuTitle, meta?: Meta): string | undefined {
  const candidates = [title.id, title.imdbId, meta?.["imdb_id"]];
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && imdbPattern.test(candidate),
  );
}

export const imdbUrl = (imdbId: string) => `https://www.imdb.com/title/${imdbId}/`;

// What a watched or progress edit makes stale: the title page's state, Continue
// Watching and the library's "Recently watched" order.
const stateKeys = ["watched", "progress", "continue-watching", "last-watched"] as const;

// The edits a title can take from a menu or its page, each going through the
// store (so they queue for Nuvio, ADR-0015) and refreshing what shows them.
// A profile's kids flag changes none of these: they write the library and
// watched marks, which a kids profile has, never tracking (ADR-0042).
export function useTitleEdits(profileId: number) {
  const client = useQueryClient();
  const libraryKey = ["library", profileId];
  // The title's own watched and progress are refetched even when nothing
  // shows them (a menu has closed), so they're right when it opens again.
  const refreshState = (contentId: string) =>
    Promise.all([
      ...stateKeys.map((prefix) => client.invalidateQueries({ queryKey: [prefix, profileId] })),
      ...(["watched", "progress"] as const).map((prefix) =>
        client.invalidateQueries({ queryKey: [prefix, profileId, contentId], refetchType: "all" }),
      ),
    ]);

  // Marks or unmarks, then keeps the series-level mark in step with the
  // episodes, as Nuvio's apps do (title page rules, lib/title.ts).
  const setWatched = useMutation({
    mutationFn: async ({
      meta,
      items,
      watched,
    }: {
      meta: Pick<Meta, "id" | "type" | "name" | "videos">;
      items: WatchedItem[];
      watched: boolean;
    }) => {
      await Store.SetWatched(profileId, items, watched);
      if (!isSeriesType(meta.type)) return;
      const [marks, progress] = await Promise.all([
        Store.TitleWatched(profileId, meta.id),
        Store.TitleProgress(profileId, meta.id),
      ]);
      const full = meta as Meta;
      const change = seriesMarkChange(full, titleState(full, marks ?? [], progress ?? []));
      if (change !== undefined) await Store.SetWatched(profileId, [titleMark(full)], change);
    },
    onError: () => toastManager.add({ type: "error", title: "Couldn’t save that" }),
    onSettled: (_result, _error, { meta }) => refreshState(meta.id),
  });

  // Adds or removes a library entry. The library shows the change at once
  // and goes back if the store refuses; a removal offers Undo.
  const saveToLibrary = useMutation({
    mutationFn: (item: LibraryItem) => Store.SaveLibraryItem(profileId, item),
    onMutate: async (item) => {
      await client.cancelQueries({ queryKey: libraryKey });
      const before = client.getQueryData<LibraryItem[]>(libraryKey);
      client.setQueryData<LibraryItem[]>(libraryKey, (list) =>
        list && !list.some((entry) => sameTitle(entry, item)) ? [...list, item] : list,
      );
      return { before };
    },
    onError: (_error, _item, context) => {
      client.setQueryData(libraryKey, context?.before);
      toastManager.add({ type: "error", title: "Couldn’t update your library" });
    },
    onSettled: () => client.invalidateQueries({ queryKey: libraryKey }),
  });

  const removeFromLibrary = useMutation({
    mutationFn: (title: Pick<LibraryItem, "contentId" | "contentType" | "name">) =>
      Store.RemoveLibraryItem(profileId, title.contentId, title.contentType),
    onMutate: async (title) => {
      await client.cancelQueries({ queryKey: libraryKey });
      const before = client.getQueryData<LibraryItem[]>(libraryKey);
      client.setQueryData<LibraryItem[]>(libraryKey, (list) =>
        list?.filter((entry) => !sameTitle(entry, title)),
      );
      return { before, saved: before?.find((entry) => sameTitle(entry, title)) };
    },
    onSuccess: (_result, title, context) =>
      toastManager.add({
        type: "success",
        title: `Removed ${title.name} from your library`,
        ...(context?.saved && {
          actionProps: { children: "Undo", onClick: () => saveToLibrary.mutate(context.saved!) },
        }),
      }),
    onError: (_error, _title, context) => {
      client.setQueryData(libraryKey, context?.before);
      toastManager.add({ type: "error", title: "Couldn’t update your library" });
    },
    onSettled: () => client.invalidateQueries({ queryKey: libraryKey }),
  });

  // Takes the given progress entries (by key) out of the store: "Clear
  // progress" on an episode, "Remove from Continue Watching" on a title.
  const clearProgress = useMutation({
    mutationFn: async ({ keys }: { contentId: string; keys: string[] }) => {
      await Promise.all(keys.map((key) => Store.RemoveProgress(profileId, key)));
    },
    onError: () => toastManager.add({ type: "error", title: "Couldn’t clear that" }),
    onSettled: (_result, _error, { contentId }) => refreshState(contentId),
  });

  // Takes a title out of Continue Watching without marking it watched (Go
  // removes its unfinished progress, which is how Nuvio does it, so it syncs
  // and comes back when the title is played). The row drops it at once, and
  // Undo saves the entries back.
  const continueKey = ["continue-watching", profileId];
  const restoreProgress = useMutation({
    mutationFn: async (entries: Progress[]) => {
      for (const entry of entries) {
        // oxlint-disable-next-line no-await-in-loop
        await Store.SaveProgress(profileId, entry);
      }
    },
    onError: () => toastManager.add({ type: "error", title: "Couldn’t put that back" }),
    onSettled: (_result, _error, entries) => refreshState(entries[0]?.contentId ?? ""),
  });
  const removeFromContinueWatching = useMutation({
    mutationFn: (variables: { contentId: string; name: string; entries: Progress[] }) =>
      Store.ClearContinueWatching(profileId, variables.contentId),
    onMutate: async ({ contentId }) => {
      await client.cancelQueries({ queryKey: continueKey });
      const before = client.getQueryData<Progress[]>(continueKey);
      client.setQueryData<Progress[]>(continueKey, (list) =>
        list?.filter((entry) => entry.contentId !== contentId),
      );
      return { before };
    },
    onSuccess: (_result, { name, entries }) =>
      toastManager.add({
        type: "success",
        title: `Removed ${name} from Continue Watching`,
        actionProps: { children: "Undo", onClick: () => restoreProgress.mutate(entries) },
      }),
    onError: (_error, _variables, context) => {
      client.setQueryData(continueKey, context?.before);
      toastManager.add({ type: "error", title: "Couldn’t clear that" });
    },
    onSettled: (_result, _error, { contentId }) => refreshState(contentId),
  });

  return {
    setWatched,
    saveToLibrary,
    removeFromLibrary,
    clearProgress,
    removeFromContinueWatching,
  };
}

const sameTitle = (
  a: Pick<LibraryItem, "contentId" | "contentType">,
  b: Pick<LibraryItem, "contentId" | "contentType">,
) => a.contentId === b.contentId && a.contentType === b.contentType;
