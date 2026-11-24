import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CalendarDays, ChevronDown, List } from "lucide-react";
import { useState } from "react";

import { EpisodeEntry } from "@/components/library/episode-entry";
import { LibraryNotice } from "@/components/library/notice";
import { UpcomingCalendar } from "@/components/library/upcoming-calendar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import {
  calendar,
  calendarShows,
  dayLabel,
  type CalendarEntry,
  type CalendarShow,
} from "@/lib/calendar";
import { useLoadedAddons } from "@/lib/home";
import { libraryQuery, type LibrarySearch } from "@/lib/library";
import { useCompactShell } from "@/lib/shell-mode";
import { cachedTitleMeta, titleMetaQuery } from "@/lib/title";
import { cn } from "@/lib/utils";
import type { Profile } from "@bindings/store";

// The Library page's Upcoming view (#48): the episodes of the library's
// shows that air from today on, by day (ADR-0032). Each show's details come
// from the title page's query, so a show seen before paints from the cache,
// offline too, and each fills in as its addon answers. Two layouts, the
// month's calendar and the list of days (?layout=list). The calendar is the
// default: it answers "what's on this month" at a glance, and the list is the
// closer read.
export function Upcoming({ profile }: { profile: Profile }) {
  const search: LibrarySearch = useSearch({ strict: false });
  const layout = search.layout ?? "calendar";
  const client = useQueryClient();
  const library = useQuery(libraryQuery(profile.id));
  const { visible, addons, loading } = useLoadedAddons(profile.id);
  const shows = calendarShows(library.data ?? []);
  const details = useQueries({
    queries: shows.map((item) => ({
      ...titleMetaQuery(addons, item.contentType, item.contentId),
      enabled: !loading,
      ...cachedTitleMeta(client, addons, item.contentType, item.contentId),
    })),
  });

  if (library.isPending) return <UpcomingSkeleton />;
  if (shows.length === 0) {
    return (
      <LibraryNotice
        icon={CalendarDays}
        title="No shows in your library"
        description="Add a show from its page and its new episodes show up here."
        action={
          <Link to="/shows" className={buttonVariants()}>
            Browse shows
          </Link>
        }
      />
    );
  }

  const loaded = shows.flatMap((item, index): CalendarShow[] => {
    const meta = details[index]?.data?.meta;
    return meta ? [{ item, meta }] : [];
  });
  // With no visible addons, nothing will answer.
  const checking = visible.data?.length !== 0 && (loading || details.some((q) => q.isPending));
  const failed = details.filter((query) => query.isError && !query.data);
  const { days, later } = calendar(loaded);

  // Only the list waits on a skeleton: the calendar paints its days (empty
  // ones too) while the shows load.
  if (layout === "list" && days.length === 0 && later.length === 0 && checking) {
    return <UpcomingSkeleton />;
  }

  return (
    <div className="flex flex-col gap-8 px-page">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-8",
          layout === "list" ? "max-w-4xl" : "max-w-[100rem]",
        )}
      >
        {/* The status and the layout switch share the first row, so the switch
            stays put whether or not there is anything to report. */}
        <div className="flex items-center justify-between gap-4">
          {checking || failed.length > 0 ? (
            <div className="flex items-center gap-3 text-body text-muted-foreground">
              {checking ? (
                <>
                  <Spinner className="size-4" />
                  Checking your shows for new episodes…
                </>
              ) : (
                <>
                  {failed.length === 1
                    ? "Couldn’t check one show."
                    : `Couldn’t check ${failed.length} shows.`}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => failed.forEach((query) => void query.refetch())}
                  >
                    Try again
                  </Button>
                </>
              )}
            </div>
          ) : (
            <span />
          )}
          <LayoutSwitch />
        </div>
        {layout === "calendar" ? (
          <UpcomingCalendar shows={loaded} />
        ) : days.length === 0 && later.length === 0 && !checking ? (
          <LibraryNotice
            icon={CalendarDays}
            title="Nothing coming up"
            description="None of the shows in your library has a new episode scheduled yet."
          />
        ) : (
          <div className="flex flex-col gap-8 ios-compact:gap-4">
            {days.map(({ day, entries }) => (
              <DaySection key={day} {...dayLabel(day)} entries={entries} />
            ))}
            {later.length > 0 && <DaySection title="Later" entries={later} dated collapsible />}
          </div>
        )}
      </div>
    </div>
  );
}

// The calendar or the list: coss Tabs as a segmented control on an ink tint,
// the Library page's view switch at the end of its header, so the two read as
// one family. The pill is a wrapper here too, since a tier sets its own
// background; the tab list inside it is bare. The default comes first.
//
// `compact` (#132, iPhone): the icons alone, as the words plus their icons
// would crowd the status message beside them.
function LayoutSwitch() {
  const search: LibrarySearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const compact = useCompactShell();
  return (
    // Replaced, as the view switch is: the layout is a preference, not a place
    // to come back to.
    <Tabs
      // Kept whole beside a long status message on an iPhone.
      className="shrink-0"
      value={search.layout ?? "calendar"}
      onValueChange={(next: string) =>
        void navigate({
          to: ".",
          search: (previous: LibrarySearch): LibrarySearch => ({
            ...previous,
            // The calendar is the default, so choosing it leaves no param.
            layout: next === "list" ? "list" : undefined,
          }),
          replace: true,
        })
      }
    >
      <span className="inline-flex rounded-full bg-foreground/7 p-1">
        <TabsList
          aria-label="Layout"
          className="gap-x-1 rounded-full bg-transparent p-0 text-muted-foreground *:data-[slot=tab-indicator]:rounded-full *:data-[slot=tab-indicator]:bg-background *:data-[slot=tab-indicator]:shadow-card dark:*:data-[slot=tab-indicator]:bg-foreground/16 dark:*:data-[slot=tab-indicator]:shadow-none"
        >
          <TabsTab
            value="calendar"
            aria-label={compact ? "Calendar" : undefined}
            className={compact ? "rounded-full px-2.5" : "gap-1.5 rounded-full px-3"}
          >
            <CalendarDays aria-hidden className="size-4" />
            {compact ? null : "Calendar"}
          </TabsTab>
          <TabsTab
            value="list"
            aria-label={compact ? "List" : undefined}
            className={compact ? "rounded-full px-2.5" : "gap-1.5 rounded-full px-3"}
          >
            <List aria-hidden className="size-4" />
            {compact ? null : "List"}
          </TabsTab>
        </TabsList>
      </span>
    </Tabs>
  );
}

// How far the sticky day headers sit under the title bar: the Library page's
// header once it has stuck on this view (py-2 around the 38px view switch,
// see BrowseFrame; only the Upcoming view has day headers, and it has one
// row, so the offset is fixed), plus 1rem so the header's own 24px scroll
// edge doesn't veil the day header's top.
const stuckHeader = "4.375rem";

// On an iPhone (#132) the day headers are a 13 pt uppercase label with the
// date ("TODAY · 17 NOV"), sticking right under the compact header: its bar's
// measured height is --library-header-h (compact-frame.tsx), 0 on an iPhone
// on its side, where the bar is gone.
const compactTop = "calc(var(--spacing-bar) + var(--library-header-h, 0px))";

function DaySection({
  title,
  date,
  entries,
  dated = false,
  collapsible = false,
}: {
  title: string;
  date?: string | undefined;
  entries: readonly CalendarEntry[];
  // Whether each entry shows its own air date (Later).
  dated?: boolean;
  // On an iPhone, starts closed behind a header with the count (Later).
  collapsible?: boolean;
}) {
  const compact = useCompactShell();
  const [open, setOpen] = useState(false);
  if (compact) {
    const closed = collapsible && !open;
    const label = date ? `${title} · ${date}` : title;
    return (
      <section aria-label={title} className="flex flex-col">
        <div style={{ top: compactTop }} className="sticky z-9 -mx-page material-bar px-page">
          {collapsible ? (
            <h2>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex min-h-11 w-full cursor-pointer items-center gap-2 text-start text-[0.8125rem] font-[590] tracking-[0.06em] text-muted-foreground uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
                <span className="tnum font-normal tracking-normal normal-case">
                  {entries.length}
                </span>
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "ms-auto size-4 transition-transform duration-(--duration-fast)",
                    open && "rotate-180",
                  )}
                />
              </button>
            </h2>
          ) : (
            <h2 className="flex min-h-9 items-center text-[0.8125rem] font-[590] tracking-[0.06em] text-muted-foreground uppercase">
              {label}
            </h2>
          )}
        </div>
        {!closed && (
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <li key={`${entry.item.contentId}:${entry.episode.id}`}>
                <EpisodeEntry entry={entry} dated={dated} compact />
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      {/* Sticks under the page header while its day scrolls by, then the next
          day's takes over. The wrapper holds the scroll edge, as a material-pop
          element can't (see glass-materials). It sits under the page header
          (z-10), so a day header pushed out by the next one slides beneath it. */}
      <div
        style={{ top: `calc(var(--spacing-bar) + ${stuckHeader})` }}
        className="sticky z-9 material-bar"
      >
        <h2 className="flex items-baseline gap-3 py-2.5 font-display text-[1.75rem] leading-none">
          {title}
          {date && <span className="tnum text-small text-muted-foreground">{date}</span>}
        </h2>
      </div>
      <ul className="flex flex-col">
        {entries.map((entry) => (
          <li key={`${entry.item.contentId}:${entry.episode.id}`}>
            <EpisodeEntry entry={entry} dated={dated} compact={false} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Two day sections' worth of rows, as tall as the real ones (p-3 around a
// w-24 poster).
function UpcomingSkeleton() {
  const compact = useCompactShell();
  if (compact) {
    // The iPhone's rows (#132): a 44×66 poster in an 82 pt row.
    return (
      <div aria-hidden className="flex flex-col px-page">
        <Skeleton className="my-2.5 h-3.5 w-32 rounded-full" />
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 py-2">
            <Skeleton className="h-[4.125rem] w-11 rounded-md" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-40 rounded" />
              <Skeleton className="h-3 w-56 max-w-full rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-page">
      <Skeleton className="mb-1 h-9 w-48 rounded-xl" />
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-5 p-3">
          <Skeleton className="aspect-[2/3] w-24 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-48 rounded" />
            <Skeleton className="h-4 w-72 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
