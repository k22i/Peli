import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarDays, ChevronDown } from "lucide-react";
import { useState } from "react";

import { LibraryNotice } from "@/components/library/notice";
import { Artwork } from "@/components/media/artwork";
import { openOnContextKey, TitleMenu } from "@/components/media/title-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  airDate,
  airTime,
  calendar,
  calendarShows,
  dayLabel,
  entryCode,
  type CalendarEntry,
  type CalendarShow,
} from "@/lib/calendar";
import { useLoadedAddons } from "@/lib/home";
import { libraryPreview, libraryQuery } from "@/lib/library";
import { cachedTitleMeta, titleMetaQuery, useOpenTitle } from "@/lib/title";
import { libraryMenuTitle } from "@/lib/title-actions";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";
import type { Profile } from "@bindings/store";

// The Library page's Upcoming view (#48): the episodes of the library's
// shows that air from today on, by day (ADR-0032). Each show's details come
// from the title page's query, so a show seen before paints from the cache,
// offline too, and each fills in as its addon answers.
export function Upcoming({ profile }: { profile: Profile }) {
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

  if (days.length === 0 && later.length === 0 && checking) return <UpcomingSkeleton />;

  return (
    <div className="flex flex-col gap-8 px-page">
      {(checking || failed.length > 0) && (
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
      )}
      {days.length === 0 && later.length === 0 && !checking ? (
        <LibraryNotice
          icon={CalendarDays}
          title="Nothing coming up"
          description="None of the shows in your library has a new episode scheduled yet."
        />
      ) : (
        <div className="flex max-w-4xl flex-col gap-8 ios-compact:gap-4">
          {days.map(({ day, entries }) => (
            <DaySection key={day} {...dayLabel(day)} entries={entries} />
          ))}
          {later.length > 0 && <DaySection title="Later" entries={later} dated collapsible />}
        </div>
      )}
    </div>
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

// An episode on the calendar. It opens its show's page on its season.
//
// `compact` (#132, iPhone): Apple TV's Up Next density, a 44×66 pt poster,
// the show in 15 pt semibold over "S2 · E5 · Episode title" in 13 pt (two
// lines at most), and the time at the end; about 82 pt a row.
function EpisodeEntry({
  entry,
  dated,
  compact,
}: {
  entry: CalendarEntry;
  dated: boolean;
  compact: boolean;
}) {
  const open = useOpenTitle();
  const { item, episode, episodes } = entry;
  const code = entryCode(entry);
  const title =
    episodes.length > 1
      ? `${episodes.length} episodes`
      : episode.title || `Episode ${episode.episode}`;
  // At the end: the day's rows show the time (when the addon gives one),
  // Later's the date.
  const end = dated ? airDate(entry.airs) : airTime(entry);
  if (compact) {
    return (
      <TitleMenu title={libraryMenuTitle(item)}>
        <button
          type="button"
          aria-label={`${item.name}, ${code}: ${title}${dated ? `, ${airDate(entry.airs)}` : ""}`}
          onClick={() => open(libraryPreview(item), { season: episode.season })}
          onKeyDown={openOnContextKey}
          className="-mx-3 flex w-[calc(100%+1.5rem)] cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-start outline-none transition-colors active:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="relative h-[4.125rem] w-11 shrink-0 overflow-hidden rounded-md shadow-card">
            <Artwork src={item.poster} use="poster" title={item.name} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[0.9375rem] leading-[1.25] font-semibold text-foreground">
              {item.name}
            </span>
            <span className="line-clamp-2 text-[0.8125rem] leading-[1.3] text-muted-foreground">
              <span className="tnum">{code}</span> · {title}
            </span>
          </span>
          {end && (
            <span className="shrink-0 text-[0.8125rem] text-muted-foreground tnum">{end}</span>
          )}
        </button>
      </TitleMenu>
    );
  }
  return (
    <TitleMenu title={libraryMenuTitle(item)}>
      <button
        type="button"
        aria-label={`${item.name}, ${code}: ${title}${dated ? `, ${airDate(entry.airs)}` : ""}`}
        onClick={() => open(libraryPreview(item), { season: episode.season })}
        onKeyDown={openOnContextKey}
        className="flex w-full cursor-pointer items-center gap-5 rounded-2xl p-3 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-lg shadow-card">
          <Artwork src={item.poster} use="poster" title={item.name} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate type-item text-foreground">{item.name}</span>
          <span className="truncate text-body text-muted-foreground">
            <span className="tnum text-small">{code}</span> · {title}
          </span>
        </span>
        {end && <span className="shrink-0 tnum text-small text-muted-foreground">{end}</span>}
      </button>
    </TitleMenu>
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
    <div aria-hidden className="flex max-w-4xl flex-col gap-1 px-page">
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
