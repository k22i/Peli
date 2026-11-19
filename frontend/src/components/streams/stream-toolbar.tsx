import { Search, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Chip } from "@/components/media/chip";
import { ScrollRail } from "@/components/media/scroll-rail";
import { Button } from "@/components/ui/button";
import { ResponsiveSelect } from "@/components/ui/responsive-select";
import {
  isFiltered,
  noFilters,
  sortLabels,
  toggle,
  withText,
  type Facet,
  type FacetChips,
  type StreamFilters,
  type StreamSort,
} from "@/lib/stream-filters";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";

// The picker's filters and sort, as `useStreamChoices` hands them over: what
// the toolbar shows and how it changes them.
export type Filtering = {
  filters: StreamFilters;
  setFilters: (filters: StreamFilters) => void;
  // The facets the streams differ on; the addon facet is the summary's.
  chips: FacetChips[];
  sort: StreamSort;
  // The sorts there's something to sort by.
  sorts: readonly StreamSort[];
  setSort: (sort: StreamSort) => void;
  // "4K only", for the top pick's card; null with no filters.
  label: string | null;
};

// Shown behind "More".
const moreFacets: ReadonlySet<Facet> = new Set(["codec"]);

// Search, sort and the filter chips, in the picker's sticky toolbar. On the
// phone the search hides behind a button, so the chips keep one line; in a
// narrow panel (`stacked`) the chips go under the search.
export function StreamToolbar({
  filtering,
  stacked = false,
}: {
  filtering: Filtering;
  stacked?: boolean;
}) {
  const compact = useCompactShell();
  const { filters, setFilters, chips, sort, sorts, setSort } = filtering;
  const [more, setMore] = useState(false);
  const [searching, setSearching] = useState(filters.text !== "");
  const facets = chips.filter(({ facet }) => facet !== "source");
  const hidden = facets.filter(
    ({ facet, options }) => moreFacets.has(facet) && !options.some((o) => o.chosen),
  );
  const shown = facets.filter((group) => more || !hidden.includes(group));
  const filtered = isFiltered(filters);

  const search = (
    <label
      className={cn(
        "flex h-9 min-w-0 items-center gap-2 rounded-full bg-foreground/6 ps-3 pe-1 text-small focus-within:ring-2 focus-within:ring-ring",
        compact || stacked ? "flex-1" : "w-56 shrink-0",
      )}
    >
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <input
        type="search"
        aria-label="Search release names"
        placeholder="Release or file name"
        value={filters.text}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose, by the search button
        autoFocus={compact && searching && filters.text === ""}
        onChange={(event) => setFilters(withText(filters, event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Escape" && filters.text) {
            event.preventDefault();
            event.stopPropagation();
            setFilters(withText(filters, ""));
          }
        }}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {filters.text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setFilters(withText(filters, ""))}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );

  const sortSelect =
    sorts.length > 1 ? (
      <ResponsiveSelect
        aria-label="Sort"
        title="Sort"
        size="sm"
        items={sorts.map((value) => ({ value, label: sortLabels[value] }))}
        value={sort}
        onValueChange={(value) => value && setSort(value)}
        className="w-auto min-w-36 shrink-0 rounded-full"
      />
    ) : null;

  const rail = (shown.length > 0 || hidden.length > 0 || filtered) && (
    <ScrollRail label="Filters" className={compact ? undefined : "min-w-0 flex-1"}>
      {compact && !searching && (
        <button
          type="button"
          aria-label="Search release names"
          onClick={() => setSearching(true)}
          className={actionChip}
        >
          <Search aria-hidden className="size-4" />
        </button>
      )}
      {shown.map((group, index) => (
        <Group key={group.facet} label={group.label} first={index === 0}>
          {group.options.map((option) => (
            <Chip
              key={option.value}
              pressed={option.chosen}
              disabled={option.count === 0 && !option.chosen}
              onPressedChange={() => setFilters(toggle(filters, group.facet, option.value))}
            >
              {option.label} <span className="tnum font-normal opacity-70">{option.count}</span>
            </Chip>
          ))}
        </Group>
      ))}
      {hidden.length > 0 && (
        <Chip aria-expanded={more} pressed={more} onPressedChange={setMore}>
          More
        </Chip>
      )}
      {filtered && (
        <button type="button" onClick={() => setFilters(noFilters)} className={actionChip}>
          <X aria-hidden className="size-3.5" />
          Clear filters
        </button>
      )}
    </ScrollRail>
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-2">
        {searching && (
          <div className="flex items-center gap-2 px-page">
            {search}
            <button
              type="button"
              onClick={() => {
                setSearching(false);
                setFilters(withText(filters, ""));
              }}
              className="shrink-0 cursor-pointer text-small font-[560] text-sun-ink"
            >
              Cancel
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{rail}</div>
          {sortSelect && <div className="shrink-0 pe-page">{sortSelect}</div>}
        </div>
      </div>
    );
  }
  if (stacked) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 px-page">
          {search}
          {sortSelect}
        </div>
        {rail}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 px-page">
      {search}
      {sortSelect}
      {rail}
    </div>
  );
}

// The list's toolbar, the top pick's note and "No streams match", for the
// picker and the player's stream switcher alike.
export function filteredListProps(
  filtering: Filtering,
  view: { top: unknown },
  { stacked = false }: { stacked?: boolean } = {},
) {
  const filtered = isFiltered(filtering.filters);
  return {
    toolbar: <StreamToolbar filtering={filtering} stacked={stacked} />,
    topNote: filtering.label,
    empty: filtered && !view.top && <NoMatch onClear={() => filtering.setFilters(noFilters)} />,
  };
}

function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-page py-10 text-center">
      <p className="text-body font-[590]">No streams match</p>
      <p className="max-w-sm text-small text-muted-foreground">
        None of the streams found so far fit every filter. Clear them, or turn some off.
      </p>
      <Button variant="secondary" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

// A chip that does something rather than filter.
const actionChip =
  "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-foreground/6 px-3.5 text-small font-[560] whitespace-nowrap text-foreground/75 outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

// One facet's chips, named for screen readers, with a hairline before it.
function Group({ label, first, children }: { label: string; first: boolean; children: ReactNode }) {
  return (
    <fieldset className="flex shrink-0 items-center gap-2">
      <legend className="sr-only">{label}</legend>
      {!first && <span aria-hidden className="mx-1 h-5 w-px bg-foreground/12" />}
      {children}
    </fieldset>
  );
}
