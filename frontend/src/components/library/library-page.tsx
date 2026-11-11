import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Library as LibraryIcon, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { BrowseFrame, GridSkeleton } from "@/components/browse/browse-page";
import { LibraryNotice } from "@/components/library/notice";
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
  continueWatchingQuery,
  episodeLabels,
  lastWatchedQuery,
  libraryItems,
  libraryMeta,
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
// the library's new episodes (#48). The header is Browse's (#116, #118): the
// title and the view switch, and under them the type chips and Sort.
export function LibraryPage() {
  const profile = useQuery(currentProfileQuery).data;
  return profile ? (
    <Library profile={profile} />
  ) : (
    <LibraryFrame>
      <GridSkeleton />
    </LibraryFrame>
  );
}

// The page: Browse's sticky header with the view switch at the end of
// its first row and, on the Titles view, the type chips and Sort in `rail`.
function LibraryFrame({ rail, children }: { rail?: ReactNode; children: ReactNode }) {
  return (
    <BrowseFrame title="Library" filter={<ViewSwitch />} rail={rail}>
      {children}
    </BrowseFrame>
  );
}

// Titles or Upcoming: coss Tabs as a segmented control on an ink tint. The
// pill is a wrapper, since a tier sets its own background; the tab list
// inside it is bare, and its indicator is the raised knob.
function ViewSwitch() {
  const search: LibrarySearch = useSearch({ strict: false });
  const navigate = useNavigate();
  return (
    // Replaced, as the filters are; the titles' filters stay in the address
    // for coming back.
    <Tabs
      value={search.view ?? "titles"}
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
      <span className="inline-flex rounded-full bg-foreground/7 p-1">
        <TabsList
          aria-label="View"
          className="gap-x-1 rounded-full bg-transparent p-0 text-muted-foreground *:data-[slot=tab-indicator]:rounded-full *:data-[slot=tab-indicator]:bg-background *:data-[slot=tab-indicator]:shadow-card dark:*:data-[slot=tab-indicator]:bg-foreground/16 dark:*:data-[slot=tab-indicator]:shadow-none"
        >
          <TabsTab value="titles" className="rounded-full px-4">
            Titles
          </TabsTab>
          <TabsTab value="upcoming" className="rounded-full px-4">
            Upcoming
          </TabsTab>
        </TabsList>
      </span>
    </Tabs>
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
  // The episode each show in progress is on, for its card.
  const progress = useQuery(continueWatchingQuery(profile.id)).data;

  // One component for both views, so the header stays mounted (and keeps
  // its scroll state) when the switch changes.
  if (search.view === "upcoming") {
    return (
      <LibraryFrame>
        <Upcoming profile={profile} />
      </LibraryFrame>
    );
  }
  if (library.isPending) {
    return (
      <LibraryFrame>
        <GridSkeleton />
      </LibraryFrame>
    );
  }
  if (!library.data) {
    return (
      <LibraryFrame>
        <LibraryNotice
          icon={LibraryIcon}
          title="Couldn’t load your library"
          description="Something went wrong reading it from this device."
          action={<Button onClick={() => void library.refetch()}>Try again</Button>}
        />
      </LibraryFrame>
    );
  }
  if (library.data.length === 0) {
    return (
      <LibraryFrame>
        <LibraryNotice
          icon={LibraryIcon}
          title="Your library is empty"
          description="Add a title from its page and it shows up here, on every device signed in to Nuvio."
          action={
            <Link to="/movies" className={buttonVariants()}>
              Browse movies
            </Link>
          }
        />
      </LibraryFrame>
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
    <LibraryFrame
      rail={
        // The type chips share one line with Sort and scroll sideways when
        // there are more than fit (#116); the rail brings its own gutter.
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
            <SelectTrigger aria-label="Sort" className="me-page w-48 shrink-0">
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
      }
    >
      <LibraryGrid profile={profile} items={items} episodes={episodeLabels(progress ?? [])} />
    </LibraryFrame>
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

function LibraryGrid({
  profile,
  items,
  episodes,
}: {
  profile: Profile;
  items: LibraryItem[];
  // The "S2 · E5" of each title in progress, by content ID.
  episodes: ReadonlyMap<string, string>;
}) {
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
              meta={libraryMeta(item, episodes.get(item.contentId))}
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
          <ContextMenuPopup className="material-pop">
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
