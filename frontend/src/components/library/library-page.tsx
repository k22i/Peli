import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowUpDown, Eye, EyeOff, Library as LibraryIcon, Trash2 } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import { BrowseFrame } from "@/components/browse/browse-page";
import { CompactLibraryFrame } from "@/components/library/compact-frame";
import { LibraryGridSkeleton, LibraryNotice } from "@/components/library/notice";
import { Upcoming } from "@/components/library/upcoming";
import { SelectionBar } from "@/components/library/selection-bar";
import { refreshSynced, usePullToRefresh } from "@/components/shell/pull-to-refresh";
import { Watchlist } from "@/components/library/watchlist";
import { PosterCard } from "@/components/media/cards";
import { Chip, ChipRail } from "@/components/media/chip";
import { PosterGrid } from "@/components/media/poster-grid";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuGroup,
  ResponsiveMenuGroupLabel,
  ResponsiveMenuItem,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuSeparator,
} from "@/components/ui/responsive-menu";
import { ResponsiveSelect } from "@/components/ui/responsive-select";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import {
  continueWatchingQuery,
  denseLibraryMeta,
  episodeLabels,
  lastWatchedQuery,
  libraryItems,
  libraryMeta,
  libraryPreview,
  libraryQuery,
  librarySorts,
  libraryTypes,
  progressFractions,
  sortCaption,
  type LibrarySearch,
  type LibrarySort,
} from "@/lib/library";
import { useBulkEdits } from "@/lib/library-bulk";
import { currentProfileQuery } from "@/lib/profile";
import { feature } from "@/lib/features";
import { useCompactShell } from "@/lib/shell-mode";
import { clickKind, selectRange, toggleKey } from "@/lib/selection";
import { useOpenTitle } from "@/lib/title";
import { libraryMenuTitle, useTitleEdits } from "@/lib/title-actions";
import { cn } from "@/lib/utils";
import type { LibraryItem, Profile } from "@bindings/store";

// The profile's library (#46): every saved title in one grid, filtered by
// type and sorted. It reads the local store, which pulls keep in step with
// Nuvio, so it shows offline too. A card's context menu (the shared title menu) or Delete on a
// focused card removes it, with Undo in the toast. The Upcoming tab is the calendar of
// the library's new episodes (#48); the Watchlist tab is what SIMKL and AniList
// have planned. The header is Browse's (#116, #118): the
// title and the view switch, and under them the type chips and Sort.
export function LibraryPage() {
  const profile = useQuery(currentProfileQuery).data;
  // Pull to refresh on iOS (#135): sync now, and the tracker lists
  // (the Watchlist view's).
  const client = useQueryClient();
  usePullToRefresh(() => refreshSynced(client));
  return profile ? (
    <Library profile={profile} />
  ) : (
    <LibraryFrame>
      <LibraryGridSkeleton />
    </LibraryFrame>
  );
}

// The page: Browse's sticky header with the view switch at the end of
// its first row and, on the Titles view, the type chips and Sort in `rail`.
// On an iPhone (#132) the compact header instead: `chips` on their own row
// and `sort` as a button at the end of the title's, with `caption` under
// the chips.
function LibraryFrame({
  rail,
  chips,
  sort,
  caption,
  children,
}: {
  rail?: ReactNode;
  chips?: ReactNode;
  sort?: ReactNode;
  caption?: string | undefined;
  children: ReactNode;
}) {
  const compact = useCompactShell();
  if (compact) {
    return (
      <CompactLibraryFrame
        title="Library"
        switcher={<ViewSwitch compact />}
        sort={sort}
        rail={chips}
        caption={caption}
      >
        {children}
      </CompactLibraryFrame>
    );
  }
  return (
    <BrowseFrame title="Library" filter={<ViewSwitch />} rail={rail}>
      {children}
    </BrowseFrame>
  );
}

// Titles, Upcoming or Watchlist: coss Tabs as a segmented control on an ink tint. The
// pill is a wrapper, since a tier sets its own background; the tab list
// inside it is bare, and its indicator is the raised knob.
//
// `compact` (#132, iPhone): a full-width segmented control, three equal
// segments (two for kids), 36 pt tall with a 9 pt radius.
function ViewSwitch({ compact = false }: { compact?: boolean }) {
  const search: LibrarySearch = useSearch({ strict: false });
  const navigate = useNavigate();
  // Kids profiles keep no tracking, so no Watchlist.
  const kids = useQuery(currentProfileQuery).data?.kids ?? false;
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
            view: next === "upcoming" || next === "watchlist" ? next : undefined,
          }),
          replace: true,
        })
      }
    >
      {compact ? (
        <TabsList
          aria-label="View"
          className={cn(
            "grid h-9 w-full gap-0 rounded-[9px] bg-foreground/7 p-0.5 text-muted-foreground *:data-[slot=tab-indicator]:rounded-[7px] *:data-[slot=tab-indicator]:bg-background *:data-[slot=tab-indicator]:shadow-card dark:*:data-[slot=tab-indicator]:bg-foreground/16 dark:*:data-[slot=tab-indicator]:shadow-none",
            kids ? "grid-cols-2" : "grid-cols-3",
          )}
        >
          <TabsTab value="titles" className={segment}>
            Titles
          </TabsTab>
          <TabsTab value="upcoming" className={segment}>
            Upcoming
          </TabsTab>
          {!kids && (
            <TabsTab value="watchlist" className={segment}>
              Watchlist
            </TabsTab>
          )}
        </TabsList>
      ) : (
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
            {!kids && (
              <TabsTab value="watchlist" className="rounded-full px-4">
                Watchlist
              </TabsTab>
            )}
          </TabsList>
        </span>
      )}
    </Tabs>
  );
}

// A compact switch's segment: the whole third (or half), 32 pt inside the
// 2 pt padding.
const segment = "h-8 min-w-0 rounded-[7px] px-1 text-[0.8125rem] font-[590] sm:h-8";

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
  if (search.view === "watchlist" && !profile.kids) {
    return (
      <LibraryFrame>
        <Watchlist profile={profile} />
      </LibraryFrame>
    );
  }
  if (library.isPending) {
    return (
      <LibraryFrame>
        <LibraryGridSkeleton />
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

  const chips =
    types.length > 1 ? (
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
    ) : undefined;

  return (
    <LibraryFrame
      chips={chips}
      sort={<SortMenu sort={sort} onChange={(next) => choose({ type, sort: next })} />}
      caption={sortCaption(sort)}
      rail={
        // The type chips share one line with Sort and scroll sideways when
        // there are more than fit (#116); the rail brings its own gutter.
        <div className="flex items-center gap-3">
          {chips ?? <div className="flex-1" />}
          <ResponsiveSelect
            items={librarySorts}
            value={sort}
            onValueChange={(next) => next && choose({ type, sort: next })}
            aria-label="Sort"
            title="Sort"
            className="me-page w-48 shrink-0"
          />
        </div>
      }
    >
      <LibraryGrid
        profile={profile}
        items={items}
        episodes={episodeLabels(progress ?? [])}
        progress={progressFractions(progress ?? [])}
      />
    </LibraryFrame>
  );
}

// The iPhone's Sort (#132): a 44 pt icon button at the end of the title row,
// whose menu (a bottom sheet, #134) lists the sorts with a check by the
// current one. librarySorts has no direction, so there is no Ascending or
// Descending row.
function SortMenu({
  sort,
  onChange,
}: {
  sort: LibrarySort;
  onChange: (next: LibrarySort) => void;
}) {
  return (
    <ResponsiveMenu
      label="Sort"
      header="Sort"
      align="end"
      trigger={{
        "aria-label": "Sort",
        className: cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "size-11 rounded-full [&_svg:not([class*='size-'])]:size-5",
        ),
        children: <ArrowUpDown aria-hidden />,
      }}
    >
      <ResponsiveMenuRadioGroup
        value={sort}
        onValueChange={(next) => {
          const option = librarySorts.find((candidate) => candidate.value === next);
          if (option) onChange(option.value);
        }}
      >
        {librarySorts.map((option) => (
          <ResponsiveMenuRadioItem key={option.value} value={option.value}>
            {option.label}
          </ResponsiveMenuRadioItem>
        ))}
      </ResponsiveMenuRadioGroup>
    </ResponsiveMenu>
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
  progress,
}: {
  profile: Profile;
  items: LibraryItem[];
  // The "S2 · E5" of each title in progress, by content ID.
  episodes: ReadonlyMap<string, string>;
  // How far into each title in progress, 0 to 1, for the dense cards' bar.
  progress: ReadonlyMap<string, number>;
}) {
  // The iPhone's dense grid (#132): three columns, one meta line and a
  // progress bar on the poster.
  const dense = useCompactShell();
  const open = useOpenTitle();
  const { removeFromLibrary } = useTitleEdits(profile.id);
  const bulk = useBulkEdits(profile.id);
  const keys = items.map(itemKey);
  // The selection, as far as the grid still shows it: filtering or sorting
  // away a title drops it.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  const selected = new Set(keys.filter((key) => chosen.has(key)));
  const picked = items.filter((item) => selected.has(itemKey(item)));
  const selecting = selected.size > 0;
  const clear = () => {
    setChosen(new Set());
    setAnchor(undefined);
  };

  // Not on iOS (ADR-0055): there is no Shift or ⌘ to start one.
  const multi = feature("multiSelect");
  const toggle = (key: string) => {
    if (!multi) return;
    setChosen(toggleKey(selected, key));
    setAnchor(key);
  };
  // Shift extends from the anchor, which stays where it was.
  const extend = (key: string) =>
    multi && setChosen(new Set([...selected, ...selectRange(keys, anchor, key)]));

  // ⌘A and Esc work from anywhere on the page, not only on a card; a menu
  // or dialog that is open keeps them for itself.
  useEffect(() => {
    if (!multi) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || inOverlay(event.target)) return;
      if (event.key === "Escape" && selecting) {
        event.preventDefault();
        clear();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        if (editable(event.target)) return;
        event.preventDefault();
        setChosen(new Set(keys));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Delete removes the focused title, or the whole selection when it is in it.
  const removeFrom = (item: LibraryItem, event: KeyboardEvent<HTMLElement>) => {
    const cell = event.currentTarget.closest<HTMLElement>("[data-item]");
    const grid = cell?.parentElement;
    const index = Number(cell?.dataset["item"]);
    const onSuccess = () => grid && focusAfterRemoval(grid, index);
    if (selected.has(itemKey(item))) {
      bulk.remove.mutate(picked, { onSuccess });
      clear();
    } else {
      removeFromLibrary.mutate(item, { onSuccess });
    }
  };

  const actOnSelection = (act: (items: readonly LibraryItem[]) => void) => () => {
    act(picked);
  };

  return (
    <>
      <PosterGrid
        label="Library"
        dense={dense}
        items={items}
        getKey={itemKey}
        isSelected={(item) => selected.has(itemKey(item))}
        renderItem={(item) => {
          const key = itemKey(item);
          const inSelection = selected.has(key);
          return (
            <PosterCard
              title={item.name}
              meta={
                dense
                  ? denseLibraryMeta(item, episodes.get(item.contentId))
                  : libraryMeta(item, episodes.get(item.contentId))
              }
              dense={dense}
              progress={dense ? progress.get(item.contentId) : undefined}
              src={item.poster}
              selected={inSelection}
              menu={libraryMenuTitle(item)}
              // A card in a selection of several speaks for all of it.
              menuItems={
                inSelection && selected.size > 1 ? (
                  <SelectionItems
                    count={selected.size}
                    onMarkWatched={() => bulk.setWatched.mutate({ items: picked, watched: true })}
                    onMarkUnwatched={() =>
                      bulk.setWatched.mutate({ items: picked, watched: false })
                    }
                    onRemove={() => {
                      bulk.remove.mutate(picked);
                      clear();
                    }}
                  />
                ) : undefined
              }
              onClick={(event) => {
                const kind = multi ? clickKind(event, selecting) : "open";
                if (kind === "toggle") toggle(key);
                else if (kind === "range") extend(key);
                else open(libraryPreview(item));
              }}
              onKeyDown={(event) => {
                if (!multi) return;
                if (event.key === " ") {
                  event.preventDefault();
                  if (event.shiftKey) extend(key);
                  else toggle(key);
                } else if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  removeFrom(item, event);
                }
              }}
              // Not the click a button sends when Space comes up.
              onKeyUp={(event) => {
                if (event.key === " ") event.preventDefault();
              }}
            />
          );
        }}
      />
      {selecting && (
        <SelectionBar
          count={selected.size}
          onMarkWatched={actOnSelection((list) =>
            bulk.setWatched.mutate({ items: list, watched: true }),
          )}
          onMarkUnwatched={actOnSelection((list) =>
            bulk.setWatched.mutate({ items: list, watched: false }),
          )}
          onRemove={() => {
            bulk.remove.mutate(picked);
            clear();
          }}
          onDone={clear}
        />
      )}
    </>
  );
}

const itemKey = (item: LibraryItem) => `${item.contentType}:${item.contentId}`;

// Whether keys go to a text field, which keeps ⌘A for its own text.
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// Whether an open menu, dialog or listbox popup owns the key.
const inOverlay = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest("[role=menu], [role=dialog], [role=listbox][data-popup]") !== null;

// The menu of a card that is in a selection: the actions on all of it.
function SelectionItems({
  count,
  onMarkWatched,
  onMarkUnwatched,
  onRemove,
}: {
  count: number;
  onMarkWatched: () => void;
  onMarkUnwatched: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <ResponsiveMenuGroup>
        <ResponsiveMenuGroupLabel>{count} selected</ResponsiveMenuGroupLabel>
        <ResponsiveMenuItem onClick={onMarkWatched}>
          <Eye aria-hidden />
          Mark watched
        </ResponsiveMenuItem>
        <ResponsiveMenuItem onClick={onMarkUnwatched}>
          <EyeOff aria-hidden />
          Mark unwatched
        </ResponsiveMenuItem>
      </ResponsiveMenuGroup>
      <ResponsiveMenuSeparator />
      <ResponsiveMenuItem onClick={onRemove}>
        <Trash2 aria-hidden />
        Remove from Library
      </ResponsiveMenuItem>
    </>
  );
}
