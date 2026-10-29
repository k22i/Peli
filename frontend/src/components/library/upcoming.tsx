import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarDays } from "lucide-react";

import { Notice } from "@/components/browse/browse-page";
import { Artwork } from "@/components/media/artwork";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  airDate,
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
      <Notice
        icon={CalendarDays}
        title="No shows in your library"
        description="Add a show from its page and its new episodes show up here."
        action={
          <Link to="/shows" className={buttonVariants({ variant: "outline" })}>
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
    <div className="flex flex-col gap-8 px-gutter">
      {(checking || failed.length > 0) && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
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
        <Notice
          icon={CalendarDays}
          title="Nothing coming up"
          description="None of the shows in your library has a new episode scheduled yet."
        />
      ) : (
        <>
          {days.map(({ day, entries }) => (
            <DaySection key={day} {...dayLabel(day)} entries={entries} />
          ))}
          {later.length > 0 && <DaySection title="Later" entries={later} dated />}
        </>
      )}
    </div>
  );
}

function DaySection({
  title,
  date,
  entries,
  dated = false,
}: {
  title: string;
  date?: string | undefined;
  entries: readonly CalendarEntry[];
  // Whether each entry shows its own air date (Later).
  dated?: boolean;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="flex items-baseline gap-3 font-heading text-heading">
        {title}
        {date && <span className="font-mono text-meta text-muted-foreground">{date}</span>}
      </h2>
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li key={`${entry.item.contentId}:${entry.episode.id}`}>
            <EpisodeEntry entry={entry} dated={dated} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// An episode on the calendar. It opens its show's page on its season.
function EpisodeEntry({ entry, dated }: { entry: CalendarEntry; dated: boolean }) {
  const open = useOpenTitle();
  const { item, episode, episodes } = entry;
  const code = entryCode(entry);
  const title =
    episodes.length > 1
      ? `${episodes.length} episodes`
      : episode.title || `Episode ${episode.episode}`;
  return (
    <button
      type="button"
      aria-label={`${item.name}, ${code}: ${title}${dated ? `, ${airDate(entry.airs)}` : ""}`}
      onClick={() => open(libraryPreview(item), { season: episode.season })}
      className="flex w-full max-w-3xl cursor-pointer items-center gap-4 rounded-xl p-2 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="relative aspect-[2/3] w-12 shrink-0 overflow-hidden rounded-md shadow-card">
        <Artwork src={item.poster} title={item.name} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-foreground">{item.name}</span>
        <span className="truncate text-sm text-muted-foreground">
          <span className="font-mono text-meta">{code}</span> · {title}
        </span>
      </span>
      {dated && (
        <span className="shrink-0 font-mono text-meta text-muted-foreground">
          {airDate(entry.airs)}
        </span>
      )}
    </button>
  );
}

function UpcomingSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3 px-gutter">
      <Skeleton className="h-6 w-32 rounded-md" />
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex max-w-3xl items-center gap-4 p-2">
          <Skeleton className="aspect-[2/3] w-12 rounded-md" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-48 rounded" />
            <Skeleton className="h-3 w-64 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
