import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Search as SearchIcon, SearchX, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";

import { NoAddons } from "@/components/addons/no-addons";
import { BrowseFrame, Notice } from "@/components/browse/browse-page";
import { PosterCard } from "@/components/media/cards";
import { Chip, ChipRail } from "@/components/media/chip";
import { Row, RowGroup, RowSkeleton } from "@/components/media/row";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { menuTitle } from "@/lib/title-actions";
import { searchQuery } from "@/lib/addon-protocol";
import { useBrowsableAddons } from "@/lib/home";
import { currentPlatform } from "@/lib/platform";
import { useLeaveOutAnime } from "@/lib/anime";
import { currentProfileQuery } from "@/lib/profile";
import { useRecentSearches } from "@/lib/recent-searches";
import { useTmdbPeople, type PersonHit } from "@/lib/tmdb-person";
import {
  filterGroups,
  groupByline,
  searchCatalogs,
  searchGenres,
  searchKinds,
  searchYears,
  changeSearch,
  type SearchChange,
  searchDebounceMs,
  searchFieldId,
  searchGroups,
  searchTerm,
  type SearchSearch,
} from "@/lib/search";
import { useOpenTitle } from "@/lib/title";
import type { Profile } from "@bindings/store";

// Search (#44): every catalog of the profile's addons that takes `search`
// is asked at once, and each addon's results show as soon as it answers, so
// a slow one holds nothing back. Results are grouped by kind in rows; ↓ from
// the field moves into them and ↑ from the first row comes back. The query
// lives in the address, so Back from a title page returns to the results.
//
// The header is Browse's (#116, #119): the "Search" title and the big material-pop
// field stick under the title bar, and once stuck the title is only for
// screen readers.
export function SearchPage() {
  const profile = useQuery(currentProfileQuery).data;
  const search: SearchSearch = useSearch({ strict: false });
  const term = searchTerm(search.q);
  const field = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);
  const recents = useRecentSearches(profile?.id);

  // The field is there from the first paint (and keeps its focus) while the
  // profile loads; what needs the profile fills in under it.
  return (
    <BrowseFrame
      title="Search"
      quietTitle
      rail={
        <div className="flex flex-col gap-3">
          <SearchField
            ref={field}
            search={search}
            onCommit={recents.add}
            onArrowDown={() =>
              results.current?.querySelector<HTMLElement>("[data-row-item][tabindex='0']")?.focus()
            }
          />
          {profile && term !== undefined && (
            <SearchFilters profile={profile} term={term} search={search} />
          )}
        </div>
      }
    >
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- handles keys bubbling up from the cards */}
      <section
        ref={results}
        aria-label="Results"
        className="flex flex-col gap-6"
        // ↑ from the first row: no row above took it, so it's the field's.
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" || event.defaultPrevented) return;
          if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-row-item"))
            return;
          event.preventDefault();
          field.current?.focus();
        }}
      >
        {profile ? (
          <FoundResults profile={profile} term={term} search={search} recents={recents} />
        ) : (
          <RowSkeleton />
        )}
      </section>
    </BrowseFrame>
  );
}

// Both ask for the same searches; the query cache answers the second.
function FoundResults(props: Omit<ComponentProps<typeof Results>, "found">) {
  const found = useSearchResults(props.profile, props.term);
  return <Results {...props} found={found} />;
}

// What narrows the results, on the header under the field: kind chips, then
// a decade and a genre (the genres the results have; none if they list none).
function SearchFilters({
  profile,
  term,
  search,
}: {
  profile: Profile;
  term: string;
  search: SearchSearch;
}) {
  const found = useSearchResults(profile, term);
  const genres = searchGenres(found.groups);
  const navigate = useNavigate();
  const set = (changes: SearchChange) =>
    void navigate({ to: ".", search: changeSearch(search, changes), replace: true });
  // Only once there is something to narrow.
  if (found.groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <ChipRail
        aria-label="Kind"
        value={[search.type ?? "all"]}
        onValueChange={(value: string[]) => {
          const [next] = value;
          if (next) set({ type: searchKinds.find((kind) => kind === next) });
        }}
      >
        <Chip value="all">All</Chip>
        <Chip value="movie">Movies</Chip>
        <Chip value="series">Shows</Chip>
        <Chip value="anime">Anime</Chip>
      </ChipRail>
      <div className="flex flex-wrap gap-2 px-page">
        <FilterSelect
          label="Year"
          allLabel="Any year"
          value={search.year ?? ""}
          options={searchYears.map((year) => ({
            value: year,
            label: year === "older" ? "Before 1990" : `${year}s`,
          }))}
          onChange={(year) => set({ year: searchYears.find((decade) => decade === year) })}
        />
        {genres.length > 0 && (
          <FilterSelect
            label="Genre"
            allLabel="Any genre"
            value={search.genre ?? ""}
            options={genres.map((genre) => ({ value: genre, label: genre }))}
            onChange={(genre) => set({ genre: genre || undefined })}
          />
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const items = [{ value: "", label: allLabel }, ...options];
  return (
    <Select items={items} value={value} onValueChange={(next) => onChange(next ?? "")}>
      <SelectTrigger aria-label={label} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

// The field writes what's typed to the address once typing pauses, or at
// once on Enter; Escape clears it, and so does the clear button, which also
// puts the cursor back in the field.
function SearchField({
  ref,
  search,
  onCommit,
  onArrowDown,
}: {
  ref: React.Ref<HTMLInputElement>;
  search: SearchSearch;
  // A search the user means: Enter on it.
  onCommit: (term: string) => void;
  onArrowDown: () => void;
}) {
  const navigate = useNavigate();
  const { q } = search;
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const [text, setText] = useState(q ?? "");
  const [focused, setFocused] = useState(false);
  // Replaced, not pushed: Back leaves the page rather than undoing typing.
  // What the field itself last wrote to the address; a different `q` came
  // from elsewhere (a recent search was picked) and replaces the text.
  const written = useRef(q ?? "");
  const submit = useCallback(
    (value: string) => {
      written.current = value.trim() ? value : "";
      // Filters belong to a query, so they go with it only while it stays.
      void navigate({
        to: ".",
        search: (previous) => (value.trim() ? { ...previous, q: value } : {}),
        replace: true,
      });
    },
    [navigate],
  );

  useEffect(() => {
    if ((q ?? "") === written.current) return;
    written.current = q ?? "";
    setText(q ?? "");
  }, [q]);

  useEffect(() => {
    if (text === (q ?? "")) return undefined;
    const timer = setTimeout(() => submit(text), searchDebounceMs);
    return () => clearTimeout(timer);
  }, [text, q, submit]);

  const clear = () => {
    setText("");
    submit("");
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      submit(text);
      const term = searchTerm(text);
      if (term) onCommit(term);
    } else if (event.key === "Escape" && text) {
      event.preventDefault();
      clear();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onArrowDown();
    }
  };

  return (
    <div className="relative max-w-3xl px-page">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute start-[calc(var(--spacing-page)+1.125rem)] top-1/2 z-10 size-5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={input}
        id={searchFieldId}
        type="search"
        unstyled
        aria-label="Search"
        placeholder="Movies, shows and anime"
        autoComplete="off"
        spellCheck={false}
        // On arriving here, from the sidebar or the shortcut, you type.
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- a search page's field is its point
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        // The coss Input sets its own height and padding on the <input>; the
        // field here is a material-pop bar, so the wrapper takes the look and the
        // input is sized from it.
        className="flex h-13 w-full rounded-full bg-foreground/7 outline-ring transition-colors hover:bg-foreground/9 has-focus-visible:bg-foreground/9 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 [&_input]:h-13 [&_input]:ps-13 [&_input]:pe-16 [&_input]:text-[1.0625rem] [&_input]:leading-13 [&_input]:font-[510] [&_input]:placeholder:text-muted-foreground"
      />
      {text ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className="absolute end-[calc(var(--spacing-page)+0.625rem)] bg-foreground/12 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-foreground outline-ring transition-[scale] duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 motion-safe:active:scale-95 [&_svg]:size-4"
        >
          <X aria-hidden />
        </button>
      ) : (
        !focused && (
          <Kbd
            aria-hidden
            className="absolute end-[calc(var(--spacing-page)+1.25rem)] top-1/2 -translate-y-1/2"
          >
            {shortcutLabel()}
          </Kbd>
        )
      )}
    </div>
  );
}

// The shortcut that focuses the field from anywhere.
const shortcutLabel = () => (currentPlatform() === "mac" ? "⌘F" : "Ctrl+F");

// The catalogs the profile's search asks and what they have answered so
// far, shared by the header (its genre filter) and the results.
function useSearchResults(profile: Profile, term: string | undefined) {
  const { visible, addons, shown, loading } = useBrowsableAddons(profile.id);
  const leaveOutAnime = useLeaveOutAnime(profile.id);
  // Not until a kids profile's allowed catalogs are known, so the rest are
  // never asked, not merely hidden, and "none can search" doesn't flash.
  const catalogs = loading ? [] : searchCatalogs(addons, shown);
  const queries = useQueries({
    queries:
      term === undefined
        ? []
        : catalogs.map(({ addon, catalog }) =>
            searchQuery(addon.url, catalog.type, catalog.id, term),
          ),
  });
  const groups = searchGroups(
    catalogs.map((source, i) => ({ source, metas: queries[i]?.data?.metas })),
    leaveOutAnime,
  );
  return { visible, loading, catalogs, queries, groups };
}

type Found = ReturnType<typeof useSearchResults>;
type Recents = {
  list: string[];
  add: (term: string) => void;
  remove: (term: string) => void;
  clear: () => void;
};

function Results({
  profile,
  term,
  search,
  found,
  recents,
}: {
  profile: Profile;
  term: string | undefined;
  search: SearchSearch;
  found: Found;
  recents: Recents;
}) {
  const open = useOpenTitle();
  const navigate = useNavigate();
  const { visible, loading, catalogs, queries } = found;
  // People aren't addon results: TMDB's, for an unfiltered search, never on a
  // kids profile (nothing can say which people they may see).
  const people = useTmdbPeople(
    term,
    !profile.kids && !search.type && !search.year && !search.genre,
  );

  if (visible.data?.length === 0) return <NoAddons profile={profile} />;
  if (loading) return term ? <RowSkeleton /> : null;
  if (catalogs.length === 0) {
    return (
      <Notice
        icon={SearchX}
        title="None of your addons can search"
        description="Install or turn on an addon that offers search, such as Cinemeta."
        action={
          <Link to="/addons" className={buttonVariants({ variant: "outline" })}>
            Manage addons
          </Link>
        }
      />
    );
  }
  if (term === undefined) {
    // Earlier searches under the empty field, then a quiet prompt.
    const count = new Set(catalogs.map(({ addon }) => addon.url)).size;
    return (
      <>
        <RecentSearches
          recents={recents}
          onPick={(recent) => void navigate({ to: ".", search: { q: recent }, replace: true })}
        />
        <Notice
          icon={SearchIcon}
          title="Search your addons’ catalogs"
          description={`Find movies, shows and anime in ${count === 1 ? "1 addon" : `${count} addons`}. Press ${shortcutLabel()} or / to search from anywhere.`}
        />
      </>
    );
  }

  const all = found.groups;
  const groups = filterGroups(all, search);
  const filtered = Boolean(search.type || search.year || search.genre);
  const addonNames = (pick: (i: number) => boolean) => [
    ...new Set(catalogs.filter((_, i) => pick(i)).map(({ addon }) => addon.manifest.name)),
  ];
  const pending = addonNames((i) => queries[i]?.isPending ?? true);
  const failed = addonNames((i) => queries[i]?.isError ?? false);
  const retry = () => {
    for (const query of queries) if (query.isError) void query.refetch();
  };

  if (all.length === 0 && pending.length === 0 && !people?.length) {
    return queries.every((query) => query.isError) ? (
      <Notice
        icon={SearchX}
        title="Couldn’t search"
        description="Your addons didn’t answer. They may be down, or you may be offline."
        action={<Button onClick={retry}>Try again</Button>}
      />
    ) : (
      <Notice
        icon={SearchX}
        title={`No results for “${term}”`}
        description="None of your addons found anything. Check the spelling, or try another title."
        action={
          failed.length > 0 && (
            <Button variant="outline" onClick={retry}>
              {`${list(failed)} didn’t answer. Try again`}
            </Button>
          )
        }
      />
    );
  }

  return (
    <>
      <output className="flex min-h-8 items-center gap-3 px-page text-body empty:sr-only">
        {pending.length > 0 && (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Spinner aria-hidden className="size-4" />
            {`Searching ${list(pending)}…`}
          </span>
        )}
        {failed.length > 0 && (
          <span className="flex items-center gap-2 text-muted-foreground">
            {`${list(failed)} didn’t answer.`}
            <Button variant="ghost" size="sm" onClick={retry}>
              Try again
            </Button>
          </span>
        )}
      </output>
      {all.length === 0 && !people?.length ? (
        <RowSkeleton />
      ) : groups.length === 0 && !people?.length ? (
        <Notice
          icon={SearchX}
          title="Nothing matches those filters"
          description="Try another kind, decade or genre, or clear them."
          action={
            <Button
              variant="outline"
              onClick={() =>
                void navigate({
                  to: ".",
                  search: changeSearch(search, {
                    type: undefined,
                    year: undefined,
                    genre: undefined,
                  }),
                  replace: true,
                })
              }
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-12">
          <RowGroup>
            {groups.map((group) => (
              <Row
                key={group.kind}
                title={
                  <>
                    {group.title}
                    <span className="font-normal text-muted-foreground">
                      {` · ${groupByline(group.addons)}`}
                    </span>
                  </>
                }
                items={group.metas}
                getKey={(meta) => meta.id}
                renderItem={(meta) => (
                  <PosterCard
                    title={meta.name}
                    meta={meta.releaseInfo}
                    src={meta.poster}
                    menu={menuTitle(meta)}
                    onClick={() => {
                      recents.add(term);
                      open(meta);
                    }}
                  />
                )}
              />
            ))}
            {people && people.length > 0 && !filtered && <PeopleRow people={people} />}
          </RowGroup>
        </div>
      )}
    </>
  );
}

// "Cinemeta", "Cinemeta and Kitsu", "Cinemeta, Kitsu and MAL".
const list = (names: readonly string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(names);

// TMDB's people for the query: photo, name and what they're known for. Each
// opens their page.
function PeopleRow({ people }: { people: PersonHit[] }) {
  const navigate = useNavigate();
  return (
    <Row
      title="People"
      items={people}
      getKey={(person) => person.id}
      renderItem={(person) => (
        <PosterCard
          title={person.name}
          meta={person.knownFor.join(", ") || person.department}
          src={person.photo}
          onClick={() => void navigate({ to: "/person/$id", params: { id: String(person.id) } })}
        />
      )}
    />
  );
}

// The profile's last searches as removable chips, under the empty field.
function RecentSearches({ recents, onPick }: { recents: Recents; onPick: (term: string) => void }) {
  if (recents.list.length === 0) return null;
  return (
    <section aria-labelledby="recent-searches" className="flex flex-col gap-3 px-page">
      <div className="flex items-center justify-between gap-4">
        <h2 id="recent-searches" className="type-heading">
          Recent searches
        </h2>
        <Button variant="ghost" size="sm" onClick={recents.clear}>
          Clear all
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {recents.list.map((recent) => (
          <li
            key={recent}
            className="flex items-center rounded-full bg-foreground/6 text-small font-[560] text-foreground/80"
          >
            <button
              type="button"
              className="h-8 rounded-s-full ps-3.5 pe-2 outline-ring hover:text-foreground focus-visible:outline-2"
              onClick={() => onPick(recent)}
            >
              {recent}
            </button>
            <button
              type="button"
              aria-label={`Remove ${recent}`}
              className="grid size-8 place-items-center rounded-e-full outline-ring hover:text-foreground focus-visible:outline-2 [&_svg]:size-3.5"
              onClick={() => recents.remove(recent)}
            >
              <X aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
