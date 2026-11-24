import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { EpisodeEntry } from "@/components/library/episode-entry";
import { Artwork } from "@/components/media/artwork";
import { Button } from "@/components/ui/button";
import {
  dayKey,
  dayLabel,
  firstWeekday,
  monthGrid,
  monthKey,
  monthLabel,
  scheduleByDay,
  shiftMonth,
  weekdayNames,
  type CalendarEntry,
  type CalendarShow,
  type MonthCell,
} from "@/lib/calendar";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";

// How far the calendar sticks under the title bar on a wide window: the
// Library page's stuck header (py-2 around the 38px view switch) plus 1rem,
// as upcoming.tsx's day headers do.
const stuckHeader = "4.375rem";

// The library's Upcoming view as a month grid: every episode of the library's
// shows in the month on screen, Apple Calendar style, with the chosen day
// listed underneath. Past days stay in the grid, dimmed, because a season's
// episodes read better in place than as a gap. Days without episodes stay
// empty rather than hidden, so the weeks keep their shape.
export function UpcomingCalendar({ shows }: { shows: readonly CalendarShow[] }): ReactElement {
  const compact = useCompactShell();
  // One reading of the clock for the render, so the grid, the labels and the
  // Today button all agree on what today is.
  const [now] = useState(() => Date.now());
  const [month, setMonth] = useState(() => monthKey(now));
  const [selected, setSelected] = useState(() => dayKey(now));
  // The locale decides which day starts the week (Sunday here, Monday in much
  // of Europe); it can't change while the app runs.
  const [weekStart] = useState(firstWeekday);

  const weeks = monthGrid(month, now, weekStart);
  // The grid's own range, edges included, so a day of the next month that
  // shows in the last row still lists its episodes.
  const from = weeks[0]?.[0]?.day;
  const until = weeks.at(-1)?.[6]?.day;
  // The compiler memoizes this render, so the schedule is built as a plain
  // value rather than behind a useMemo it can't preserve.
  const byDay =
    from && until ? scheduleByDay(shows, from, until) : new Map<string, CalendarEntry[]>();

  const days = weeks.flat();
  const today = dayKey(now);
  const thisMonth = monthKey(now);

  // Which day to open when the month changes: today if it's there, else the
  // first day of that month with something airing, else the 1st.
  const selectFor = (next: string): string => {
    if (next === thisMonth) return today;
    const grid = monthGrid(next, now, weekStart);
    const start = grid[0]?.[0]?.day;
    const end = grid.at(-1)?.[6]?.day;
    if (start && end) {
      const schedule = scheduleByDay(shows, start, end);
      for (const week of grid) {
        for (const cell of week) {
          if (cell.inMonth && (schedule.get(cell.day)?.length ?? 0) > 0) return cell.day;
        }
      }
    }
    return `${next}-01`;
  };

  const shift = (by: number) => {
    const next = shiftMonth(month, by);
    setMonth(next);
    setSelected(selectFor(next));
  };

  // Roving focus, as a date picker does it: one cell in the tab order, the
  // arrows and Home/End move the selection inside the visible grid. They
  // never change the month, so a key can't scroll the page sideways by
  // accident.
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusMoved = useRef(false);

  useEffect(() => {
    if (!focusMoved.current) return;
    focusMoved.current = false;
    cellRefs.current.get(selected)?.focus();
  }, [selected]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, day: string) => {
    const index = days.findIndex((cell) => cell.day === day);
    if (index < 0) return;
    const start = index - (index % 7);
    let to: number;
    switch (event.key) {
      case "ArrowLeft":
        to = index - 1;
        break;
      case "ArrowRight":
        to = index + 1;
        break;
      case "ArrowUp":
        to = index - 7;
        break;
      case "ArrowDown":
        to = index + 7;
        break;
      case "Home":
        to = start;
        break;
      case "End":
        to = start + 6;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = days[Math.min(Math.max(to, 0), days.length - 1)];
    if (!target || target.day === day) return;
    focusMoved.current = true;
    setSelected(target.day);
  };

  const renderCell = (cell: MonthCell) => {
    const entries = byDay.get(cell.day) ?? [];
    const count = entries.reduce((total, entry) => total + entry.episodes.length, 0);
    const label = dayLabel(cell.day, now);
    const when = label.date ? ` ${label.date}` : "";
    const airs = count === 0 ? "nothing airs" : count === 1 ? "1 episode" : `${count} episodes`;
    const isSelected = cell.day === selected;
    // A day that has aired, but not today: its rows step back.
    const dim = cell.past && !cell.today;
    return (
      <td key={cell.day} className={cn("p-0 align-top", !compact && "border border-border/60")}>
        <button
          type="button"
          aria-pressed={isSelected}
          ref={(element) => {
            if (element) cellRefs.current.set(cell.day, element);
            else cellRefs.current.delete(cell.day);
          }}
          tabIndex={isSelected ? 0 : -1}
          aria-label={`${label.title}${when}, ${airs}`}
          onClick={() => {
            setSelected(cell.day);
            // A day of the month beside this one belongs to that month.
            if (!cell.inMonth) setMonth(cell.day.slice(0, 7));
          }}
          onKeyDown={(event) => onKeyDown(event, cell.day)}
          className={cn(
            "flex w-full cursor-pointer flex-col outline-none transition-colors",
            compact
              ? "h-12 items-center justify-start gap-1 rounded-lg pt-1 focus-visible:ring-2 focus-visible:ring-ring"
              : "min-h-32 @[68rem]:min-h-[clamp(4.75rem,calc((100dvh-var(--spacing-bar)-14rem)/6),8rem)] overflow-hidden gap-1.5 bg-background p-2 text-start hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            !cell.inMonth &&
              (compact ? "text-muted-foreground/50" : "bg-foreground/2 text-muted-foreground/60"),
            !compact && isSelected && "bg-accent/60 hover:bg-accent/60",
          )}
        >
          <span
            className={cn(
              "grid place-items-center rounded-full tnum",
              compact ? "size-8 text-[1.0625rem]" : "size-7 text-small",
              cell.today
                ? "bg-sun font-semibold text-sun-foreground"
                : compact && isSelected && "bg-foreground font-semibold text-background",
            )}
          >
            {Number(cell.day.slice(8))}
          </span>
          {compact ? (
            <span className="flex gap-0.5">
              {entries.slice(0, 3).map((entry) => (
                <span
                  key={`${entry.item.contentId}:${entry.episode.id}`}
                  className={cn("size-1.5 rounded-full", dim ? "bg-muted-foreground/50" : "bg-sun")}
                />
              ))}
            </span>
          ) : (
            <>
              {entries.slice(0, 3).map((entry) => (
                <span
                  key={`${entry.item.contentId}:${entry.episode.id}`}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 rounded-md bg-foreground/5 py-0.5 ps-0.5 pe-1.5",
                    dim && "opacity-60",
                  )}
                >
                  <span className="relative h-6 w-4 shrink-0 overflow-hidden rounded-[3px]">
                    <Artwork src={entry.item.poster} use="poster" title={entry.item.name} />
                  </span>
                  <span className="truncate text-[0.75rem] leading-tight font-medium">
                    {entry.item.name}
                  </span>
                </span>
              ))}
              {entries.length > 3 && (
                <span className="ps-1 text-[0.75rem] text-muted-foreground">
                  +{entries.length - 3} more
                </span>
              )}
            </>
          )}
        </button>
      </td>
    );
  };

  const day = dayLabel(selected, now);
  const dayEntries = byDay.get(selected) ?? [];
  const dayHeading = day.date ? `${day.title} · ${day.date}` : day.title;

  // A real table, so the rows and cells need no roles of their own. The
  // chosen day is the pressed button.
  const head = (
    <thead>
      <tr>
        {weekdayNames(weekStart, compact ? "narrow" : "short").map((name) => (
          <th
            key={name}
            scope="col"
            className={cn(
              "text-center text-muted-foreground",
              compact
                ? "py-1 text-[0.6875rem] font-[590]"
                : "border border-border/60 bg-background py-2 text-[0.75rem] font-[590] tracking-[0.06em] uppercase",
            )}
          >
            {name}
          </th>
        ))}
      </tr>
    </thead>
  );

  const body = (
    <tbody>
      {weeks.map((week) => (
        <tr key={week[0]?.day ?? ""}>{week.map(renderCell)}</tr>
      ))}
    </tbody>
  );

  return (
    // A container, so the two-up layout below follows the space this grid
    // actually gets rather than the window's width, and the calendar can stay
    // stacked in a narrow pane.
    <div className="@container w-full">
      {/* On a wide window the calendar is pinned on the left and the chosen
          day's episodes scroll past it on the right; stacked otherwise. */}
      <div
        className={cn(
          "flex flex-col gap-6",
          !compact &&
            "@[68rem]:grid @[68rem]:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)] @[68rem]:items-start @[68rem]:gap-10",
        )}
      >
        {/* The header and the grid stick together, so the month and its days
            stay on screen while the list on the right scrolls. */}
        <div
          style={compact ? undefined : { top: `calc(var(--spacing-bar) + ${stuckHeader})` }}
          className={cn(
            "flex flex-col gap-6",
            !compact && "max-w-5xl @[68rem]:max-w-none @[68rem]:sticky @[68rem]:z-1",
          )}
        >
          <div className="flex items-center gap-3">
            <h2 className="font-display text-[1.75rem] leading-none" aria-live="polite">
              {monthLabel(month)}
            </h2>
            <div className="ms-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={month === thisMonth && selected === today}
                onClick={() => {
                  setMonth(thisMonth);
                  setSelected(today);
                }}
              >
                Today
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous month"
                onClick={() => shift(-1)}
              >
                <ChevronLeft aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next month"
                onClick={() => shift(1)}
              >
                <ChevronRight aria-hidden />
              </Button>
            </div>
          </div>
          {compact ? (
            <table
              aria-label={monthLabel(month)}
              className="w-full table-fixed border-separate border-spacing-y-1"
            >
              {head}
              {body}
            </table>
          ) : (
            // The table is a hair wider than its wrapper and pulled a hair up
            // and left, so the outermost cell borders sit under the wrapper's
            // own border and the rounded corners stay clean.
            <div className="overflow-hidden rounded-2xl border border-border/60">
              <table
                aria-label={monthLabel(month)}
                className="-m-px w-[calc(100%+2px)] table-fixed border-collapse"
              >
                {head}
                {body}
              </table>
            </div>
          )}
        </div>
        <section
          aria-label={day.title}
          className={cn(
            "flex flex-col gap-1",
            // Stacked, the list keeps the calendar's measure, as it had when
            // both shared one wrapper; side by side, its grid column sets it.
            !compact && "max-w-5xl @[68rem]:max-w-none @[68rem]:min-h-[50vh]",
          )}
        >
          {compact ? (
            <h3 className="flex min-h-9 items-center text-[0.8125rem] font-[590] tracking-[0.06em] text-muted-foreground uppercase">
              {dayHeading}
            </h3>
          ) : (
            <h3 className="flex items-baseline gap-3 py-2.5 font-display text-[1.75rem] leading-none @[68rem]:pt-0">
              {day.title}
              {day.date && (
                <span className="tnum text-small text-muted-foreground">{day.date}</span>
              )}
            </h3>
          )}
          {dayEntries.length === 0 ? (
            <p className="py-3 text-body text-muted-foreground">Nothing airs this day.</p>
          ) : (
            <ul className="flex flex-col">
              {dayEntries.map((entry) => (
                <li key={`${entry.item.contentId}:${entry.episode.id}`}>
                  <EpisodeEntry entry={entry} dated={false} compact={compact} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
