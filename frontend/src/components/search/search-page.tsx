import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Search as SearchIcon, SearchX, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { NoAddons } from "@/components/addons/no-addons";
import { BrowseFrame, Notice } from "@/components/browse/browse-page";
import { PosterCard } from "@/components/media/cards";
import { Row, RowGroup, RowSkeleton } from "@/components/media/row";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { searchQuery } from "@/lib/addon-protocol";
import { useBrowsableAddons } from "@/lib/home";
import { currentPlatform } from "@/lib/platform";
import { useLeaveOutAnime } from "@/lib/anime";
import { currentProfileQuery } from "@/lib/profile";
import {
  groupByline,
  searchCatalogs,
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
// The header is Browse's (#116, #119): the "Search" title and the big glass
// field stick under the title bar, and once stuck the title is only for
// screen readers.
export function SearchPage() {
  const profile = useQuery(currentProfileQuery).data;
  const { q }: SearchSearch = useSearch({ strict: false });
  const field = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);

  return (
    <BrowseFrame
      title="Search"
      quietTitle
      rail={
        <SearchField
          ref={field}
          q={q}
          onArrowDown={() =>
            results.current?.querySelector<HTMLElement>("[data-row-item][tabindex='0']")?.focus()
          }
        />
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
        {profile ? <Results profile={profile} term={searchTerm(q)} /> : <RowSkeleton />}
      </section>
    </BrowseFrame>
  );
}

// The field writes what's typed to the address once typing pauses, or at
// once on Enter; Escape clears it, and so does the clear button, which also
// puts the cursor back in the field.
function SearchField({
  ref,
  q,
  onArrowDown,
}: {
  ref: React.Ref<HTMLInputElement>;
  q: string | undefined;
  onArrowDown: () => void;
}) {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const [text, setText] = useState(q ?? "");
  const [focused, setFocused] = useState(false);
  // Replaced, not pushed: Back leaves the page rather than undoing typing.
  const submit = useCallback(
    (value: string) =>
      void navigate({ to: ".", search: value.trim() ? { q: value } : {}, replace: true }),
    [navigate],
  );

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
    } else if (event.key === "Escape" && text) {
      event.preventDefault();
      clear();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onArrowDown();
    }
  };

  return (
    <div className="relative max-w-3xl px-gutter">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute start-[calc(var(--spacing-gutter)+1.25rem)] top-1/2 z-10 size-5 -translate-y-1/2 text-muted-foreground"
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
        // field here is a glass bar, so the wrapper takes the look and the
        // input is sized from it.
        className="glass flex h-14 w-full rounded-2xl outline-ring has-focus-visible:outline-2 has-focus-visible:outline-offset-2 [&_input]:h-14 [&_input]:ps-14 [&_input]:pe-16 [&_input]:text-heading [&_input]:leading-14 [&_input]:placeholder:text-muted-foreground"
      />
      {text ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className="glass-thin absolute end-[calc(var(--spacing-gutter)+0.75rem)] top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-foreground outline-ring transition-[scale] duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 motion-safe:active:scale-95 [&_svg]:size-4"
        >
          <X aria-hidden />
        </button>
      ) : (
        !focused && (
          <Kbd
            aria-hidden
            className="absolute end-[calc(var(--spacing-gutter)+1.25rem)] top-1/2 -translate-y-1/2"
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

function Results({ profile, term }: { profile: Profile; term: string | undefined }) {
  const open = useOpenTitle();
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
    // Nothing is stored of earlier searches, and none is added (#119): a quiet
    // prompt until there's something to look for.
    const count = new Set(catalogs.map(({ addon }) => addon.url)).size;
    return (
      <Notice
        icon={SearchIcon}
        title="Search your addons’ catalogs"
        description={`Find movies, shows and anime in ${count === 1 ? "1 addon" : `${count} addons`}. Press ${shortcutLabel()} or / to search from anywhere.`}
      />
    );
  }

  const groups = searchGroups(
    catalogs.map((source, i) => ({ source, metas: queries[i]?.data?.metas })),
    leaveOutAnime,
  );
  const addonNames = (pick: (i: number) => boolean) => [
    ...new Set(catalogs.filter((_, i) => pick(i)).map(({ addon }) => addon.manifest.name)),
  ];
  const pending = addonNames((i) => queries[i]?.isPending ?? true);
  const failed = addonNames((i) => queries[i]?.isError ?? false);
  const retry = () => {
    for (const query of queries) if (query.isError) void query.refetch();
  };

  if (groups.length === 0 && pending.length === 0) {
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
      <output className="flex min-h-8 items-center gap-3 px-gutter text-body">
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
      {groups.length === 0 ? (
        <RowSkeleton />
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
                    onClick={() => open(meta)}
                  />
                )}
              />
            ))}
          </RowGroup>
        </div>
      )}
    </>
  );
}

// "Cinemeta", "Cinemeta and Kitsu", "Cinemeta, Kitsu and MAL".
const list = (names: readonly string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(names);
