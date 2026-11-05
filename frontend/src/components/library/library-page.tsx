import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Library as LibraryIcon, Trash2 } from "lucide-react";

import { GridSkeleton, Notice } from "@/components/browse/browse-page";
import { Upcoming } from "@/components/library/upcoming";
import { PosterCard } from "@/components/media/cards";
import { Chip, ChipRail } from "@/components/media/chip";
import { PosterGrid } from "@/components/media/poster-grid";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import {
  lastWatchedQuery,
  libraryItems,
  libraryPreview,
  libraryQuery,
  librarySorts,
  libraryTypes,
  type LibrarySearch,
  type LibrarySort,
} from "@/lib/library";
import { currentProfileQuery } from "@/lib/profile";
import { useOpenTitle } from "@/lib/title";
import type { LibraryItem, Profile } from "@bindings/store";
import { Service as Store } from "@bindings/store";

// The profile's library (#46): every saved title in one grid, filtered by
// type and sorted. It reads the local store, which pulls keep in step with
// Nuvio, so it shows offline too. A card's context menu, or Delete on a
// focused card, removes it, with Undo in the toast. The Upcoming tab is the calendar of
// the library's new episodes (#48).
export function LibraryPage() {
  const profile = useQuery(currentProfileQuery).data;
  const search: LibrarySearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const view = search.view ?? "titles";
  return (
    <div className="flex flex-col gap-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-gutter">
        <h1 className="font-heading text-title font-stretch-semi-expanded">Library</h1>
        {/* Replaced, as the filters are; the titles' filters stay in the
            address for coming back. */}
        <Tabs
          value={view}
          onValueChange={(next: string) =>
            void navigate({
              to: ".",
              search: (previous: LibrarySearch): LibrarySearch => ({
                ...previous,
                view: next === "upcoming" ? "upcoming" : undefined,
              }),
              replace: true,
            })
          }
        >
          <TabsList aria-label="View">
            <TabsTab value="titles">Titles</TabsTab>
            <TabsTab value="upcoming">Upcoming</TabsTab>
          </TabsList>
        </Tabs>
      </div>
      {!profile ? (
        <GridSkeleton />
      ) : view === "upcoming" ? (
        <Upcoming profile={profile} />
      ) : (
        <Library profile={profile} />
      )}
    </div>
  );
}

function Library({ profile }: { profile: Profile }) {
  const search: LibrarySearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const library = useQuery(libraryQuery(profile.id));
  const sort = search.sort ?? "added";
  // One read of the local store, like the library's. Until it's in, titles
  // keep the order they were added in.
  const lastWatched = useQuery(lastWatchedQuery(profile.id)).data;

  if (library.isPending) return <GridSkeleton />;
  if (!library.data) {
    return (
      <Notice
        icon={LibraryIcon}
        title="Couldn’t load your library"
        description="Something went wrong reading it from this device."
        action={<Button onClick={() => void library.refetch()}>Try again</Button>}
      />
    );
  }
  if (library.data.length === 0) {
    return (
      <Notice
        icon={LibraryIcon}
        title="Your library is empty"
        description="Add a title from its page and it shows up here, on every device signed in to Nuvio."
        action={
          <Link to="/movies" className={buttonVariants({ variant: "outline" })}>
            Browse movies
          </Link>
        }
      />
    );
  }

  const types = libraryTypes(library.data);
  const type = types.some((option) => option.type === search.type) ? search.type : undefined;
  const items = libraryItems(library.data, { type, sort }, lastWatched);
  // Replaced, not pushed: Back leaves the page rather than undoing filters.
  // The defaults stay out of the address.
  const choose = (next: { type: string | undefined; sort: LibrarySort }) =>
    void navigate({
      to: ".",
      search: {
        ...(next.type ? { type: next.type } : {}),
        ...(next.sort === "added" ? {} : { sort: next.sort }),
      },
      replace: true,
    });

  return (
    <>
      {/* The type chips share one line with Sort and scroll sideways when
          there are more than fit (#116); the rail brings its own gutter. */}
      <div className="flex items-center gap-3">
        {types.length > 1 ? (
          <ChipRail
            railClassName="min-w-0 flex-1"
            aria-label="Type"
            value={[type ?? allTypes]}
            onValueChange={(value: string[]) => {
              const [next] = value;
              if (next) choose({ type: next === allTypes ? undefined : next, sort });
            }}
          >
            <Chip value={allTypes}>All</Chip>
            {types.map((option) => (
              <Chip key={option.type} value={option.type}>
                {option.label}
              </Chip>
            ))}
          </ChipRail>
        ) : (
          <div className="flex-1" />
        )}
        <Select
          items={librarySorts}
          value={sort}
          onValueChange={(next: LibrarySort | null) => next && choose({ type, sort: next })}
        >
          <SelectTrigger aria-label="Sort" className="me-gutter w-48 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {librarySorts.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <LibraryGrid profile={profile} items={items} />
    </>
  );
}

// Keeps the keyboard in the grid after Delete: the title that took the
// removed one's place, or the one before it at the end. Runs a frame later,
// once the refreshed library has rendered.
function focusAfterRemoval(grid: HTMLElement, index: number) {
  const card = (at: number) =>
    grid.querySelector<HTMLElement>(`[data-item="${at}"] [data-row-item]`);
  requestAnimationFrame(() => (card(index) ?? card(index - 1))?.focus());
}

// The All chip's value. Base UI gives a toggle with an empty value an ID.
const allTypes = "all";

function LibraryGrid({ profile, items }: { profile: Profile; items: LibraryItem[] }) {
  const client = useQueryClient();
  const open = useOpenTitle();
  const refresh = () => client.invalidateQueries({ queryKey: ["library", profile.id] });
  const restore = useMutation({
    mutationFn: (item: LibraryItem) => Store.SaveLibraryItem(profile.id, item),
    onError: () => toastManager.add({ type: "error", title: "Couldn’t put that back" }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (item: LibraryItem) =>
      Store.RemoveLibraryItem(profile.id, item.contentId, item.contentType),
    onSuccess: (_, item) =>
      toastManager.add({
        type: "success",
        title: `Removed ${item.name} from your library`,
        actionProps: { children: "Undo", onClick: () => restore.mutate(item) },
      }),
    onError: () => toastManager.add({ type: "error", title: "Couldn’t update your library" }),
    onSettled: refresh,
  });

  return (
    <PosterGrid
      label="Library"
      items={items}
      getKey={(item) => `${item.contentType}:${item.contentId}`}
      renderItem={(item) => (
        <ContextMenu>
          <ContextMenuTrigger className="contents">
            <PosterCard
              title={item.name}
              meta={item.releaseInfo}
              src={item.poster}
              onClick={() => open(libraryPreview(item))}
              onKeyDown={(event) => {
                if (event.key !== "Delete" && event.key !== "Backspace") return;
                event.preventDefault();
                const cell = event.currentTarget.closest<HTMLElement>("[data-item]");
                const grid = cell?.parentElement;
                const index = Number(cell?.dataset["item"]);
                remove.mutate(item, { onSuccess: () => grid && focusAfterRemoval(grid, index) });
              }}
            />
          </ContextMenuTrigger>
          <ContextMenuPopup>
            <ContextMenuItem variant="destructive" onClick={() => remove.mutate(item)}>
              <Trash2 aria-hidden />
              Remove from Library
            </ContextMenuItem>
          </ContextMenuPopup>
        </ContextMenu>
      )}
    />
  );
}
