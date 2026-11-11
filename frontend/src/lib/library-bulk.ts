import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { LibraryItem } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import { toastManager } from "@/components/ui/toast";
import { useLoadedAddons } from "@/lib/home";
import {
  cachedTitleMeta,
  episodeMarks,
  episodes as episodesOf,
  isSeriesType,
  mainEpisodes,
  titleMark,
  titleMetaQuery,
  titleProgressQuery,
  titleState,
  titleWatchedQuery,
} from "@/lib/title";
import { useTitleEdits } from "@/lib/title-actions";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// What the Library's selection bar and its menu do to several titles at once.
// Each goes through the same store calls as one title's (lib/title-actions.ts),
// so it queues for Nuvio the same way; the library shows a removal at once,
// and both offer Undo.
export function useBulkEdits(profileId: number) {
  const client = useQueryClient();
  const edits = useTitleEdits(profileId);
  const { addons } = useLoadedAddons(profileId);

  // Marks or unmarks each title by the title page's rules: a film by its own
  // mark, a series by its aired episodes (so its details are needed). Titles
  // already in the state asked for are left alone, so Undo only reverses
  // what changed. A series whose details can't be had is counted, not guessed.
  const setWatched = useMutation({
    mutationFn: async ({ items, watched }: { items: readonly LibraryItem[]; watched: boolean }) => {
      const changed: LibraryItem[] = [];
      let failed = 0;
      for (const item of items) {
        try {
          // One title at a time, so the store and the addons aren't flooded.
          // oxlint-disable-next-line no-await-in-loop
          const [meta, marks, progress] = await Promise.all([
            titleMeta(item),
            client.fetchQuery({ ...titleWatchedQuery(profileId, item.contentId), staleTime: 0 }),
            client.fetchQuery({ ...titleProgressQuery(profileId, item.contentId), staleTime: 0 }),
          ]);
          const state = titleState(meta, marks, progress);
          const series = isSeriesType(meta.type);
          if ((series ? state.seriesWatched : state.watched()) === watched) continue;
          const marked = series
            ? [titleMark(meta), ...episodeMarks(meta, mainEpisodes(episodesOf(meta)))]
            : [titleMark(meta)];
          if (series && marked.length === 1) throw new Error("no episodes");
          // oxlint-disable-next-line no-await-in-loop
          await edits.setWatched.mutateAsync({ meta, items: marked, watched });
          changed.push(item);
        } catch {
          failed += 1;
        }
      }
      return { changed, failed };
    },
    onSuccess: ({ changed, failed }, { watched }) => {
      if (failed > 0) {
        toastManager.add({
          type: "error",
          title: `Couldn’t mark ${plural(failed, "title", "titles")}`,
          description: "A series needs its details to mark its episodes.",
        });
      }
      if (changed.length === 0) return;
      toastManager.add({
        type: "success",
        title: `Marked ${plural(changed.length, "title", "titles")} ${watched ? "watched" : "unwatched"}`,
        actionProps: {
          children: "Undo",
          onClick: () => setWatched.mutate({ items: changed, watched: !watched }),
        },
      });
    },
  });

  // A film has no episodes, so its details aren't asked for; a series' come
  // from the cache or the first addon that has them.
  async function titleMeta(item: LibraryItem) {
    const base = { id: item.contentId, type: item.contentType, name: item.name };
    if (!isSeriesType(item.contentType)) return base;
    const { meta } = await client.fetchQuery({
      ...titleMetaQuery(addons, item.contentType, item.contentId),
      ...cachedTitleMeta(client, addons, item.contentType, item.contentId),
    });
    return meta;
  }

  const libraryKey = ["library", profileId];
  const restore = useMutation({
    mutationFn: async (items: readonly LibraryItem[]) => {
      await Promise.all(items.map((item) => Store.SaveLibraryItem(profileId, item)));
    },
    onError: () => toastManager.add({ type: "error", title: "Couldn’t put those back" }),
    onSettled: () => client.invalidateQueries({ queryKey: libraryKey }),
  });
  const remove = useMutation({
    mutationFn: async (items: readonly LibraryItem[]) => {
      await Promise.all(
        items.map((item) => Store.RemoveLibraryItem(profileId, item.contentId, item.contentType)),
      );
    },
    onMutate: async (items) => {
      await client.cancelQueries({ queryKey: libraryKey });
      const before = client.getQueryData<LibraryItem[]>(libraryKey);
      client.setQueryData<LibraryItem[]>(libraryKey, (list) =>
        list?.filter(
          (entry) =>
            !items.some(
              (item) =>
                item.contentId === entry.contentId && item.contentType === entry.contentType,
            ),
        ),
      );
      return { before };
    },
    onSuccess: (_result, items) =>
      toastManager.add({
        type: "success",
        title: `Removed ${plural(items.length, "title", "titles")} from your library`,
        actionProps: { children: "Undo", onClick: () => restore.mutate(items) },
      }),
    onError: (_error, _items, context) => {
      client.setQueryData(libraryKey, context?.before);
      toastManager.add({ type: "error", title: "Couldn’t update your library" });
    },
    onSettled: () => client.invalidateQueries({ queryKey: libraryKey }),
  });

  return { setWatched, remove };
}
