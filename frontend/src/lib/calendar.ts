import type { LibraryItem } from "@bindings/store";
import type { Meta } from "@/lib/addon-protocol";
import { episodeCode, episodes, type Episode } from "@/lib/title";

// The library's upcoming episodes (#48), on the Library page's Upcoming
// view: every episode of a saved show that airs from today on, by day, for
// the next four weeks, then each show's next episode after that (ADR-0032).

// How far ahead the calendar lists every episode, in days. Past it, only
// each show's next one shows, so a show that lists a whole season ahead
// doesn't fill the page.
export const calendarDays = 28;

// The library titles that can have episodes: anything that isn't a film.
// Kitsu types its anime "series" or "movie", and channels list videos
// without seasons, which `episodes` leaves out.
export const calendarShows = (library: readonly LibraryItem[]) =>
  library.filter((item) => item.contentType !== "movie");

// A show from the library with its details from an addon.
export type CalendarShow = { item: LibraryItem; meta: Meta };

// One show's episodes on one day: usually one, or several when a show
// releases them together. `episode` is the first.
export type CalendarEntry = CalendarShow & { episode: Episode; episodes: Episode[]; airs: number };

export type CalendarDay = { day: string; entries: CalendarEntry[] };

export type Calendar = {
  // Day by day, from today, for `calendarDays` days.
  days: CalendarDay[];
  // Each show's next episode after that, soonest first.
  later: CalendarEntry[];
};

// A local date as "2026-10-30", which sorts as it reads. Air dates show as
// the title page shows them, in the viewer's time zone.
const pad = (value: number) => String(value).padStart(2, "0");

export function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Midnight local time, `days` days after `time`'s day.
function startOfDay(time: number, days = 0): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

// Episodes from today on, Specials left out (they're extras and recaps, and
// Nuvio's apps don't count them either), each show's in episode order. An
// episode with no date, or one that can't be read, isn't scheduled.
export function calendar(shows: readonly CalendarShow[], now = Date.now()): Calendar {
  const from = startOfDay(now);
  const until = startOfDay(now, calendarDays);
  const soon: CalendarEntry[] = [];
  const later: CalendarEntry[] = [];
  for (const show of shows) {
    let next: CalendarEntry | undefined;
    for (const episode of episodes(show.meta)) {
      const airs = episode.released === undefined ? Number.NaN : Date.parse(episode.released);
      if (episode.season === 0 || Number.isNaN(airs) || airs < from) continue;
      const entry = { ...show, episode, episodes: [episode], airs };
      if (airs < until) soon.push(entry);
      else if (!next || airs < next.airs) next = entry;
    }
    // A show already on the calendar this month isn't repeated in Later.
    if (next && !soon.some((entry) => entry.item === show.item)) later.push(next);
  }

  const byTime = (a: CalendarEntry, b: CalendarEntry) =>
    a.airs - b.airs || collator.compare(a.item.name, b.item.name);
  const days = new Map<string, CalendarEntry[]>();
  for (const entry of soon.toSorted(byTime)) {
    const day = dayKey(entry.airs);
    const entries = days.get(day) ?? [];
    // A show's episodes on the same day share one entry.
    const same = entries.find((other) => other.item === entry.item);
    if (same) same.episodes.push(entry.episode);
    else days.set(day, [...entries, entry]);
  }
  return {
    days: [...days].map(([day, entries]) => ({ day, entries })),
    later: later.toSorted(byTime),
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const thisYear = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const otherYear = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

// A day's heading: Today, Tomorrow or the weekday within the week, with the
// date beside it ("30 Oct"); past that the date itself ("Monday 16
// November"), with the year when it isn't this one.
export function dayLabel(day: string, now = Date.now()): { title: string; date?: string } {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const time = new Date(year, month - 1, date).getTime();
  const near = (title: string) => ({ title, date: dayMonth.format(time) });
  if (day === dayKey(now)) return near("Today");
  if (day === dayKey(startOfDay(now, 1))) return near("Tomorrow");
  if (time < startOfDay(now, 7)) return near(weekday.format(time));
  return { title: (year === new Date(now).getFullYear() ? thisYear : otherYear).format(time) };
}

// An entry's episodes: "S3 · E1–E4" for a run in one season, otherwise the
// first one's code and how many more.
export function entryCode(entry: CalendarEntry): string {
  const list = entry.episodes;
  const [first] = list;
  const last = list.at(-1);
  if (!first || !last || first === last) return first ? episodeCode(first) : "";
  const run =
    list.every((e) => e.season === first.season) &&
    last.episode - first.episode === list.length - 1;
  return run
    ? `S${first.season} · E${first.episode}–E${last.episode}`
    : `${episodeCode(first)} +${list.length - 1}`;
}

const short = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

// When a Later episode airs: "16 Jan 2027".
export const airDate = (time: number) => short.format(time);

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const msPerDay = 86_400_000;

// When an entry's first episode airs that day, in the viewer's time zone
// ("9:00 PM"). Addons mostly give a date, which parses as midnight UTC and is
// no time at all, so those have none.
export const airTime = (entry: CalendarEntry): string | undefined =>
  entry.airs % msPerDay === 0 ? undefined : clock.format(entry.airs);
