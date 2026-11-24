import { Artwork } from "@/components/media/artwork";
import { openOnContextKey, TitleMenu } from "@/components/media/title-menu";
import { airDate, airTime, entryCode, type CalendarEntry } from "@/lib/calendar";
import { libraryPreview } from "@/lib/library";
import { useOpenTitle } from "@/lib/title";
import { libraryMenuTitle } from "@/lib/title-actions";

// An episode on the calendar. It opens its show's page on its season.
//
// `compact` (#132, iPhone): Apple TV's Up Next density, a 44×66 pt poster,
// the show in 15 pt semibold over "S2 · E5 · Episode title" in 13 pt (two
// lines at most), and the time at the end; about 82 pt a row.
export function EpisodeEntry({
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
