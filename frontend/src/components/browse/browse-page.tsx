import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { LayoutGrid, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { NoAddons } from "@/components/addons/no-addons";
import { AnimePosterCard } from "@/components/media/anime-poster-card";
import { PosterCard } from "@/components/media/cards";
import { Chip, ChipRail } from "@/components/media/chip";
import { PosterGrid } from "@/components/media/poster-grid";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  catalogPagesQuery,
  catalogQuery,
  type LoadedAddon,
  type MetaPreview,
} from "@/lib/addon-protocol";
import {
  browseCatalogs,
  browseTitle,
  canPage,
  catalogFilter,
  type BrowseCatalog,
  type BrowseFilter,
  type BrowseKind,
  type BrowseSearch,
} from "@/lib/browse";
import { useLeaveOutAnime } from "@/lib/anime";
import { useAnimePosterAddon } from "@/lib/anime-posters";
import { homeLayoutQuery, isReleased, useBrowsableAddons } from "@/lib/home";
import { currentProfileQuery } from "@/lib/profile";
import { useOpenTitle } from "@/lib/title";
import { cn } from "@/lib/utils";
import type { Profile } from "@bindings/store";

// Movies, Shows and Anime (#43): the profile's catalogs of one kind as chips
// on one line that scrolls sideways (#116), in addon order, and the chosen one
// as a grid that loads more as it scrolls. A catalog that takes a genre gets
// a Genre or Year filter from its own options. The choice lives in the
// address (BrowseSearch), so Back from a title page (#45) returns to it.
export function BrowsePage({ kind }: { kind: BrowseKind }) {
  const profile = useQuery(currentProfileQuery).data;
  return profile ? (
    <Browse kind={kind} profile={profile} />
  ) : (
    <BrowseFrame title={browseTitle(kind)}>
      <GridSkeleton />
    </BrowseFrame>
  );
}

// The page: a header with the title, the filter and the catalog rail, which
// sticks under the title bar as a material-pop strip once the grid scrolls beneath it
// (#116), and the body below. The Library page uses it too (#118).
//
// `quietTitle` (Search, #119): once the header sticks the title leaves the
// screen but stays for screen readers, and the row it sat in gives its space
// back, so the strip is just the field.
export function BrowseFrame({
  title,
  filter,
  rail,
  quietTitle = false,
  children,
}: {
  title: string;
  filter?: ReactNode;
  rail?: ReactNode;
  quietTitle?: boolean;
  children: ReactNode;
}) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const header = useRef<HTMLElement | null>(null);
  const [stuck, setStuck] = useState(false);

  // A 1px sentinel at the page's top leaves the view the moment the header
  // sticks. The title bar covers the top of the window, so the view starts
  // below it: the header's own `top`.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !header.current || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const top = Number.parseFloat(getComputedStyle(header.current).top) || 0;
    const observer = new IntersectionObserver(
      (entries) => setStuck(!entries[entries.length - 1]!.isIntersecting),
      { rootMargin: `-${top}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative flex flex-col pb-6">
      <div
        ref={sentinel}
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
      />
      <header
        ref={header}
        data-stuck={stuck || undefined}
        className="group/header sticky top-(--spacing-bar) z-10 mb-5 transition-[background-color,box-shadow] duration-(--duration-base) data-stuck:material-bar data-stuck:shadow-[0_1px_0_var(--border)]"
      >
        <div className="flex flex-col gap-4 pt-8 pb-4 motion-safe:transition-[padding,gap] motion-safe:duration-(--duration-base) motion-safe:ease-out-soft group-data-stuck/header:gap-3 group-data-stuck/header:pt-2 group-data-stuck/header:pb-3">
          <div
            className={cn(
              "flex items-end justify-between gap-x-6 gap-y-2 px-page",
              quietTitle && "group-data-stuck/header:-mb-3",
            )}
          >
            <h1
              className={cn(
                "font-display text-[clamp(2.75rem,1.9rem+2.6vw,4.5rem)] leading-[0.95] tracking-[-0.01em] motion-safe:transition-[font-size] motion-safe:duration-(--duration-base) motion-safe:ease-out-soft group-data-stuck/header:text-[1.875rem]",
                quietTitle && "group-data-stuck/header:sr-only",
              )}
            >
              {title}
            </h1>
            {filter}
          </div>
          {rail}
        </div>
      </header>
      {children}
    </div>
  );
}

function Browse({ kind, profile }: { kind: BrowseKind; profile: Profile }) {
  const title = browseTitle(kind);
  const search: BrowseSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const { visible, addons, shown, loading } = useBrowsableAddons(profile.id);
  const hideUnreleased = useQuery(homeLayoutQuery(profile.id)).data?.hideUnreleased ?? false;
  const leaveOutAnime = useLeaveOutAnime(profile.id);
  const posterAddon = useAnimePosterAddon(profile.id);

  if (visible.data?.length === 0) {
    return (
      <BrowseFrame title={title}>
        <NoAddons profile={profile} />
      </BrowseFrame>
    );
  }
  if (loading) {
    return (
      <BrowseFrame title={title}>
        <GridSkeleton />
      </BrowseFrame>
    );
  }
  const catalogs = browseCatalogs(addons, kind, shown);
  const selected = catalogs.find((catalog) => catalog.ref === search.catalog) ?? catalogs[0];
  if (!selected) {
    return (
      <BrowseFrame title={title}>
        <NoCatalogs kind={kind} />
      </BrowseFrame>
    );
  }

  const filter = catalogFilter(selected.catalog);
  const genre =
    filter && search.genre !== undefined && filter.options.includes(search.genre)
      ? search.genre
      : filter?.required
        ? filter.options[0]
        : undefined;
  // Replaced, not pushed: Back leaves the page rather than undoing filters.
  const choose = (next: BrowseSearch) => void navigate({ to: ".", search: next, replace: true });

  return (
    <BrowseFrame
      title={title}
      filter={
        filter && (
          <FilterSelect
            filter={filter}
            value={genre ?? ""}
            onChange={(next) => choose({ catalog: selected.ref, ...(next ? { genre: next } : {}) })}
          />
        )
      }
      rail={
        <ChipRail
          aria-label="Catalogs"
          value={[selected.ref]}
          onValueChange={(value: string[]) => {
            const [ref] = value;
            if (ref) choose({ catalog: ref });
          }}
        >
          {catalogs.map((catalog) => (
            <Chip key={catalog.ref} value={catalog.ref}>
              {catalog.label}
            </Chip>
          ))}
        </ChipRail>
      }
    >
      <CatalogGrid
        key={`${selected.ref}|${genre ?? ""}`}
        source={selected}
        genre={genre}
        hideUnreleased={hideUnreleased}
        // Anime is the Anime tab's (#109).
        leaveOut={kind === "anime" ? undefined : leaveOutAnime}
        posterAddon={kind === "anime" ? posterAddon : undefined}
      />
    </BrowseFrame>
  );
}

// "All genres", then the catalog's own options in its order (Cinemeta lists
// years newest first). A required one has no "all".
function FilterSelect({
  filter,
  value,
  onChange,
}: {
  filter: BrowseFilter;
  value: string;
  onChange: (value: string) => void;
}) {
  const items = [
    ...(filter.required ? [] : [{ value: "", label: `All ${filter.label.toLowerCase()}s` }]),
    ...filter.options.map((option) => ({ value: option, label: option })),
  ];
  return (
    <Select items={items} value={value} onValueChange={(next) => onChange(next ?? "")}>
      <SelectTrigger aria-label={filter.label} className="w-44">
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

// How many pages a grid reads on its own while they add nothing, before it
// waits for the user to scroll.
const maxEmptyPages = 20;

// One catalog, page by page. The first page is Home's, so a catalog Home
// showed paints from cache at once and refreshes behind.
function CatalogGrid({
  source: { addon, catalog, label },
  genre,
  hideUnreleased,
  leaveOut,
  posterAddon,
}: {
  source: BrowseCatalog;
  genre: string | undefined;
  hideUnreleased: boolean;
  leaveOut?: ((id: string) => boolean) | undefined;
  // The Anime tab's poster addon, if the profile picked one.
  posterAddon?: LoadedAddon | undefined;
}) {
  const client = useQueryClient();
  const open = useOpenTitle();
  const extra = genre === undefined ? {} : { genre };
  const firstPage = catalogQuery(addon.url, catalog.type, catalog.id, extra).queryKey;
  const pages = useInfiniteQuery({
    ...catalogPagesQuery(addon.url, catalog.type, catalog.id, { extra, paged: canPage(catalog) }),
    initialData: () => {
      const first = client.getQueryData(firstPage);
      return first && { pages: [first], pageParams: [0] };
    },
    initialDataUpdatedAt: () => client.getQueryState(firstPage)?.dataUpdatedAt,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Addons repeat titles across pages; the first stays. Counts what the
  // last page added, so a page left out whole asks for the next.
  const seen = new Set<string>();
  const metas: MetaPreview[] = [];
  let lastPageAdded = 0;
  const loaded = pages.data?.pages ?? [];
  for (const [i, page] of loaded.entries()) {
    const before = metas.length;
    for (const meta of page.metas) {
      if (seen.has(meta.id) || (hideUnreleased && !isReleased(meta)) || leaveOut?.(meta.id)) {
        continue;
      }
      seen.add(meta.id);
      metas.push(meta);
    }
    if (i === loaded.length - 1) lastPageAdded = metas.length - before;
  }
  // The grid asks for more as its end comes near, and only when new items
  // arrive: with none, the next page is asked here (#109), up to a point.
  const pageCount = loaded.length;
  const starved = pageCount > 0 && lastPageAdded === 0 && pageCount < maxEmptyPages;
  useEffect(() => {
    if (starved) loadMore();
  }, [starved, loadMore]);

  if (pages.isPending) return <GridSkeleton />;
  if (!pages.data) {
    return (
      <Notice
        title={`Couldn’t load ${label}`}
        description="The addon didn’t answer. It may be down, or you may be offline."
        action={<Button onClick={() => void pages.refetch()}>Try again</Button>}
      />
    );
  }

  if (metas.length === 0 && !hasNextPage) {
    return (
      <Notice
        title="Nothing here"
        description={genre ? `${label} has nothing for ${genre}.` : `${label} is empty.`}
      />
    );
  }

  return (
    <>
      <PosterGrid
        label={genre ? `${label}, ${genre}` : label}
        items={metas}
        getKey={(meta) => meta.id}
        renderItem={(meta) =>
          posterAddon ? (
            <AnimePosterCard
              id={meta.id}
              posterAddon={posterAddon}
              title={meta.name}
              meta={meta.releaseInfo}
              src={meta.poster}
              onClick={() => open(meta)}
            />
          ) : (
            <PosterCard
              title={meta.name}
              meta={meta.releaseInfo}
              src={meta.poster}
              onClick={() => open(meta)}
            />
          )
        }
        onEndReached={loadMore}
      />
      <div className="flex min-h-10 justify-center px-page">
        {isFetchingNextPage ? (
          <Spinner aria-label="Loading more" />
        ) : (
          pages.isFetchNextPageError && (
            <Button variant="outline" onClick={() => void fetchNextPage()}>
              Couldn’t load more. Try again
            </Button>
          )
        )}
      </div>
    </>
  );
}

function NoCatalogs({ kind }: { kind: BrowseKind }) {
  const title = browseTitle(kind).toLowerCase();
  return (
    <Notice
      title={`No ${title} to browse`}
      description={`None of your addons lists ${title}. Install or turn on one that does.`}
      action={
        <Link to="/addons" className={buttonVariants({ variant: "outline" })}>
          Manage addons
        </Link>
      }
    />
  );
}

// A page's empty or error state; Search shares it.
export function Notice({
  title,
  description,
  action,
  icon: Icon = LayoutGrid,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h2>{title}</h2>
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function GridSkeleton() {
  return (
    <div
      aria-hidden
      className="grid grid-cols-[repeat(auto-fill,minmax(var(--container-poster),1fr))] gap-x-4 gap-y-7 px-page"
    >
      {Array.from({ length: 14 }, (_, index) => (
        <Skeleton key={index} className="aspect-[2/3] rounded-card" />
      ))}
    </div>
  );
}
