import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState, useSearch } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  History,
  Play,
  TriangleAlert,
  Users,
  Zap,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { scrollParent } from "@/components/media/poster-grid";
import { ScrollRail } from "@/components/media/scroll-rail";
import { prefersReducedMotion } from "@/components/media/roving";
import { StreamBadge } from "@/components/streams/stream-badge";
import { Kbd } from "@/components/ui/kbd";
import { ResponsiveContextMenu, ResponsiveMenuItem } from "@/components/ui/responsive-menu";
import type { ContentType } from "@/lib/addon-protocol";
import { downloadTarget, useStreamDownloads, type StreamDownloads } from "@/lib/download-pick";
import { downloadable, useDownloads } from "@/lib/downloads";
import { useLoadedAddons } from "@/lib/home";
import { currentProfileQuery } from "@/lib/profile";
import { collapsedTiers, type Candidate, type RankedView, type Tier } from "@/lib/ranking";
import { cachedTitleMeta, titleMetaQuery } from "@/lib/title";
import {
  audioLabel,
  bitrateLabel,
  delivery,
  languagesLabel,
  rawNames,
  reasonsLabel,
  resolutionLabel,
  sizeText,
  sourceLabel,
  tierLabel,
  videoCodecLabel,
} from "@/lib/stream-labels";
import { useCompactShell } from "@/lib/shell-mode";
import { toastManager } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// The ranked streams (#52): the top pick, then a group per quality, each
// stream told by its badges rather than its file name. The two collapsed
// groups (CAM / TS and likely fakes) open on their heading.
//
// One addon can send over a thousand streams, so the list scrolls with the
// page and is virtualized. It's one Tab stop: the arrow keys, Home and End
// move between rows, Enter plays, I shows a row's file name. Moving into the
// list pins the top pick, so it doesn't change under the user. A sticky
// toolbar over it holds the filters and sort (`toolbar`) and a jump strip,
// one entry per group, that 1–9 reach from the keyboard too. In the
// player's stream switcher (#68), the stream playing is marked, and a top
// pick that matches the show's remembered source (#58) says so.

export type ListRow =
  | { kind: "top"; candidate: Candidate }
  // `open` is null for a group that's always open.
  | { kind: "group"; tier: Tier; count: number; open: boolean | null }
  | { kind: "stream"; candidate: Candidate };

// The rows for `view`, with the collapsed groups in `open` opened. The top
// pick leaves its group, so it shows once.
export function listRows(view: RankedView, open: ReadonlySet<Tier>): ListRow[] {
  const out: ListRow[] = view.top ? [{ kind: "top", candidate: view.top }] : [];
  for (const { tier, items } of view.groups) {
    const shown = items.filter((candidate) => candidate !== view.top);
    if (shown.length === 0) continue;
    const collapsible = collapsedTiers.has(tier);
    const opened = !collapsible || open.has(tier);
    out.push({ kind: "group", tier, count: shown.length, open: collapsible ? opened : null });
    if (opened) for (const candidate of shown) out.push({ kind: "stream", candidate });
  }
  return out;
}

const rowKey = (row: ListRow) =>
  row.kind === "group" ? `group:${row.tier}` : row.kind === "top" ? "top" : row.candidate.key;
const focusable = (row: ListRow) => row.kind !== "group" || row.open !== null;

// Heights before a row is measured.
const rowPx = { top: 176, group: 56, stream: 68 } as const;
// The phone's rows (#136): a 64 pt stream row, a 13 pt heading, a tighter card.
const phoneRowPx = { top: 232, group: 40, stream: 64 } as const;

// A jump strip entry: the top pick or a group, by its row.
type Jump = { index: number; key: string; label: string; count: number | null };

const jumpLabels: Partial<Record<Tier, string>> = { "Low quality": "CAM / TS" };

export function jumpTargets(rows: readonly ListRow[]): Jump[] {
  return rows.flatMap((row, index): Jump[] => {
    if (row.kind === "top") return [{ index, key: "top", label: "Top pick", count: null }];
    if (row.kind !== "group") return [];
    const label = jumpLabels[row.tier] ?? row.tier;
    return [{ index, key: `group:${row.tier}`, label, count: row.count }];
  });
}

// The number keys reach the strip's first nine entries.
const jumpKeys = 9;

// The title's runtime in minutes, for the bitrate estimate beside a size.
const Runtime = createContext<number | null>(null);

export function StreamList({
  rows,
  names,
  onNavigate,
  onPick,
  onToggleGroup,
  playing,
  usual,
  toolbar,
  topNote,
  empty,
  panel = false,
  runtime = null,
}: {
  rows: readonly ListRow[];
  // The title's (or episode's) length in minutes, when known.
  runtime?: number | null;
  // The filters and sort, in the sticky toolbar above the jump strip.
  toolbar?: ReactNode;
  // What the filters keep, on the top pick's card: "4K only".
  topNote?: string | null;
  // Shown under the toolbar when the filters leave nothing outside the
  // collapsed groups.
  empty?: ReactNode;
  // In the player's stream switcher: the toolbar sticks to the panel's top,
  // not under the title bar.
  panel?: boolean;
  // Addon names, by URL.
  names: ReadonlyMap<string, string>;
  // Whether a candidate is the stream playing.
  playing?: (candidate: Candidate) => boolean;
  // Whether a candidate matches the source the show last played from.
  usual?: (candidate: Candidate) => boolean;
  onNavigate: () => void;
  onPick: (candidate: Candidate) => void;
  onToggleGroup: (tier: Tier) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const compact = useCompactShell();
  const heights = compact ? phoneRowPx : rowPx;
  const bar = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState(0);
  // By key, since rows move as answers arrive.
  const [active, setActive] = useState<string | null>(null);
  const [named, setNamed] = useState<ReadonlySet<string>>(new Set());

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    const parent = scrollParent(element);
    setScroller(parent);
    const update = () =>
      setTop(
        element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop,
      );
    update();
    // jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    if (parent.firstElementChild) observer.observe(parent.firstElementChild);
    // The toolbar grows as chips appear, moving the list down.
    if (bar.current) observer.observe(bar.current);
    return () => observer.disconnect();
  }, []);

  // No React Compiler in this app: nothing here is memoized behind its back.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: (index) => heights[rows[index]!.kind],
    // Nothing laid out (jsdom, a hidden page): keep the estimate.
    measureElement: (element) =>
      element.getBoundingClientRect().height ||
      heights[rows[Number(element.getAttribute("data-index"))]?.kind ?? "stream"],
    getItemKey: (index) => rowKey(rows[index]!),
    scrollMargin: top,
    // A jump lands its group under the sticky toolbar.
    scrollPaddingStart: barHeight + 8,
    overscan: 6,
    initialRect: { width: 0, height: window.innerHeight },
  });
  const items = virtualizer.getVirtualItems();

  // Where the toolbar sticks (the title bar's height, measured in px: the
  // variable is in rem, and on iOS a calc() with the status bar's), and how
  // tall it is: a group is "in view" once it reaches the toolbar's bottom.
  const [stickAt, setStickAt] = useState(0);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return undefined;
    const measure = () => {
      setBarHeight(element.getBoundingClientRect().height);
      setStickAt(panel ? 0 : Number.parseFloat(getComputedStyle(element).top) || 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel]);
  const scrolled = virtualizer.scrollOffset ?? 0;
  const jumps = jumpTargets(rows);
  const line = scrolled + stickAt + barHeight + 16;
  let inView = jumps[0]?.key;
  for (const jump of scrolled > 0 ? jumps : []) {
    if ((virtualizer.measurementsCache[jump.index]?.start ?? Number.POSITIVE_INFINITY) >= line) {
      break;
    }
    inView = jump.key;
  }

  // The list's one Tab stop: the active row, or the first one shown when
  // it's scrolled away or gone.
  const mounted = items.map((item) => rows[item.index]!).filter(focusable);
  const stop = mounted.some((row) => rowKey(row) === active)
    ? active
    : mounted[0] && rowKey(mounted[0]);

  const focusRow = (index: number) => {
    const target = () => list.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`);
    setActive(rowKey(rows[index]!));
    const found = target();
    if (found) {
      found.focus({ preventScroll: true });
      found.scrollIntoView?.({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      return;
    }
    virtualizer.scrollToIndex(index);
    requestAnimationFrame(() => target()?.focus());
  };

  const nextFocusable = (from: number, step: 1 | -1) => {
    for (let index = from + step; index >= 0 && index < rows.length; index += step) {
      if (focusable(rows[index]!)) return index;
    }
    return -1;
  };

  // A jump: the group's heading to the top, under the toolbar, with focus
  // on the heading (on the first stream, for a group that's always open).
  const jumpTo = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const target = focusable(row) ? index : nextFocusable(index, 1);
    virtualizer.scrollToIndex(index, {
      align: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    if (target < 0) return;
    setActive(rowKey(rows[target]!));
    const focus = (tries: number) =>
      requestAnimationFrame(() => {
        const found = list.current?.querySelector<HTMLElement>(`[data-row-index="${target}"]`);
        if (found) found.focus({ preventScroll: true });
        else if (tries > 0) focus(tries - 1);
      });
    focus(10);
  };
  const latestJump = useRef({ jumps, jumpTo });
  useLayoutEffect(() => {
    latestJump.current = { jumps, jumpTo };
  });
  // 1–9 jump to the strip's entries, unless the user is typing.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!/^[1-9]$/.test(event.key) || typingIn(event.target)) return;
      const jump = latestJump.current.jumps[Number(event.key) - 1];
      if (!jump) return;
      event.preventDefault();
      latestJump.current.jumpTo(jump.index);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleName = (key: string) =>
    setNamed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const onRowKeyDown = (index: number, event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const row = rows[index]!;
    let to = -1;
    if (event.key === "ArrowDown") to = nextFocusable(index, 1);
    else if (event.key === "ArrowUp") to = nextFocusable(index, -1);
    else if (event.key === "Home") to = nextFocusable(-1, 1);
    else if (event.key === "End") to = nextFocusable(rows.length, -1);
    else if (event.key.toLowerCase() === "i" && row.kind !== "group") {
      event.preventDefault();
      toggleName(rowKey(row));
      return;
    } else return;
    event.preventDefault();
    if (to >= 0) focusRow(to);
  };

  return (
    <Runtime.Provider value={runtime}>
      <RowDownloadHost>
        <div className="relative">
          <div
            ref={bar}
            className={cn(
              "sticky z-10 flex flex-col gap-2 py-2 material-bar",
              panel ? "top-0" : "top-(--spacing-bar)",
            )}
          >
            {toolbar}
            {jumps.length > 1 && (
              <JumpStrip
                jumps={jumps}
                current={inView}
                compact={compact}
                onJump={(jump) => jumpTo(jump.index)}
              />
            )}
          </div>
          {empty}
          <ol
            ref={list}
            aria-label="Streams"
            className="relative px-page"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => {
              const row = rows[item.index]!;
              const key = rowKey(row);
              const rowProps = {
                "data-row-index": item.index,
                tabIndex: key === stop ? 0 : -1,
                onFocus: () => {
                  setActive(key);
                  onNavigate();
                },
                onPointerDown: onNavigate,
                onKeyDown: (event: KeyboardEvent<HTMLElement>) => onRowKeyDown(item.index, event),
              };
              return (
                <li
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute inset-x-page top-0"
                  style={{ transform: `translateY(${item.start - top}px)` }}
                >
                  {row.kind === "group" ? (
                    <GroupHeading
                      row={row}
                      compact={compact}
                      rowProps={rowProps}
                      onToggle={() => onToggleGroup(row.tier)}
                    />
                  ) : (
                    <RowMenu candidate={row.candidate}>
                      <StreamRow
                        compact={compact}
                        candidate={row.candidate}
                        best={row.kind === "top"}
                        usual={row.kind === "top" && (usual?.(row.candidate) ?? false)}
                        note={row.kind === "top" ? (topNote ?? null) : null}
                        current={playing?.(row.candidate) ?? false}
                        addon={names.get(row.candidate.source) ?? ""}
                        named={named.has(key)}
                        rowProps={rowProps}
                        onPick={() => onPick(row.candidate)}
                        onToggleName={() => toggleName(key)}
                      />
                    </RowMenu>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </RowDownloadHost>
    </Runtime.Provider>
  );
}

// The strip of groups under the toolbar: "Top pick · 4K 42 · 1080p 120 · …",
// the one in view marked. Real links in the page's navigation (buttons that
// move focus to the group), with the number key that reaches each. On the
// phone it's a line of chips that scrolls sideways.
function JumpStrip({
  jumps,
  current,
  compact,
  onJump,
}: {
  jumps: readonly Jump[];
  current: string | undefined;
  compact: boolean;
  onJump: (jump: Jump) => void;
}) {
  return (
    <nav aria-label="Stream groups">
      <ScrollRail>
        <ul className="flex shrink-0 items-center gap-1">
          {jumps.map((jump, index) => {
            const here = jump.key === current;
            const key = index < jumpKeys ? String(index + 1) : undefined;
            return (
              <li key={jump.key} className="flex shrink-0 items-center gap-1">
                {!compact && index > 0 && (
                  <span aria-hidden className="text-muted-foreground/60">
                    ·
                  </span>
                )}
                <button
                  type="button"
                  aria-current={here ? "location" : undefined}
                  aria-keyshortcuts={key}
                  title={key ? `${jump.label} (${key})` : jump.label}
                  onClick={() => onJump(jump)}
                  className={cn(
                    "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-small font-[560] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    here
                      ? "bg-foreground text-background"
                      : compact
                        ? "bg-foreground/6 text-foreground/75 hover:bg-foreground/10"
                        : "text-foreground/70 hover:bg-foreground/6 hover:text-foreground",
                  )}
                >
                  {jump.label}
                  {jump.count !== null && " "}
                  {jump.count !== null && (
                    <span className="tnum font-normal opacity-70">{jump.count}</span>
                  )}
                  {key && !compact && (
                    <Kbd
                      aria-hidden
                      className={cn(
                        "hidden h-4 min-w-4 pointer-fine:inline-flex",
                        here && "bg-background/20 text-background",
                      )}
                    >
                      {key}
                    </Kbd>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollRail>
    </nav>
  );
}

const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

type RowProps = {
  "data-row-index": number;
  tabIndex: number;
  onFocus: () => void;
  onPointerDown: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

const groupNotes: Partial<Record<Tier, string>> = {
  "Low quality": "Filmed in a cinema: real, but poor picture and sound",
  "Likely fake": "Another episode, another year, too small or not a video",
};

// A quality group's heading: its name and how many streams it holds. The
// collapsed groups are a button that opens them.
function GroupHeading({
  row,
  rowProps,
  compact = false,
  onToggle,
}: {
  row: Extract<ListRow, { kind: "group" }>;
  rowProps?: RowProps;
  // The phone (#136): 13 pt uppercase, in the glass band.
  compact?: boolean;
  onToggle: () => void;
}) {
  const label = (
    <>
      {tierLabel(row.tier)}{" "}
      <span className="tnum text-small font-normal text-muted-foreground">{row.count}</span>
    </>
  );
  const inner =
    row.open === null ? (
      <span className="block px-4 py-1.5">{label}</span>
    ) : (
      <button
        type="button"
        {...rowProps}
        aria-expanded={row.open}
        onClick={onToggle}
        className="pointer-events-auto flex w-full cursor-pointer items-center gap-2 rounded-full px-4 py-1.5 text-start outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 text-muted-foreground transition-transform duration-fast ease-out-soft",
            row.open && "rotate-90",
          )}
        />
        <span>{label}</span>
        <span className="ms-auto text-small font-normal text-muted-foreground">
          {groupNotes[row.tier]}
        </span>
      </button>
    );
  const type = compact
    ? "text-[0.8125rem] font-[650] tracking-[0.04em] uppercase"
    : "text-[0.9375rem] font-[650] tracking-[-0.01em]";
  return <h2 className={`${compact ? "pt-4 pb-1" : "pt-6 pb-1"} ${type}`}>{inner}</h2>;
}

// "1080p Blu-ray": what the picture is. The parts are separate spans, spaced
// by a gap, so a stream with no source has no stray space.
function streamName(candidate: Candidate) {
  const { parsed } = candidate;
  return {
    quality: resolutionLabel(parsed) ?? "Unknown quality",
    source: sourceLabel(parsed),
  };
}

function StreamRow({
  compact,
  candidate,
  best,
  usual,
  note,
  current,
  addon,
  named,
  rowProps,
  onPick,
  onToggleName,
}: {
  // The phone's two-line rows and tighter top pick (#136).
  compact: boolean;
  candidate: Candidate;
  best: boolean;
  usual: boolean;
  // What the filters keep, after "Top pick".
  note: string | null;
  current: boolean;
  addon: string;
  named: boolean;
  rowProps: RowProps;
  onPick: () => void;
  onToggleName: () => void;
}) {
  const runtime = useContext(Runtime);
  const nameId = `stream-name-${rowProps["data-row-index"]}`;
  const { quality, source } = streamName(candidate);
  const fileName = (
    <button
      type="button"
      tabIndex={rowProps.tabIndex}
      aria-label="File name"
      aria-expanded={named}
      aria-controls={named ? nameId : undefined}
      title="File name (I)"
      onClick={onToggleName}
      onFocus={rowProps.onFocus}
      onKeyDown={rowProps.onKeyDown}
      className={cn(
        "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full pointer-coarse:size-11 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        named && "bg-accent text-foreground",
      )}
    >
      <FileText className="size-4" />
    </button>
  );

  if (best && compact) {
    return (
      <div className="py-1 pb-3">
        <div className="relative isolate flex flex-col gap-3 overflow-hidden rounded-3xl bg-card p-4 shadow-float hairline before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(80%_140%_at_100%_50%,color-mix(in_srgb,var(--sun)_16%,transparent),transparent_70%)]">
          <div className="flex items-start gap-1">
            <button
              type="button"
              {...rowProps}
              onClick={onPick}
              aria-describedby={named ? nameId : undefined}
              className="-m-1 flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-2 rounded-2xl p-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2 text-small font-semibold text-sun-ink">
                <span className="type-eyebrow">Top pick</span>
                {note && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{note}</span>
                  </>
                )}
                {usual && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="flex items-center gap-1">
                      <History aria-hidden className="size-3.5" />
                      Same source as last time
                    </span>
                  </>
                )}
                {current && <span aria-hidden>·</span>}
                {current && <Playing />}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2 font-display text-[1.75rem] leading-none">
                <span>{quality}</span>
                {source && <span>{source}</span>}
              </span>
              <Badges candidate={candidate} />
              <Details candidate={candidate} addon={addon} />
            </button>
            {fileName}
          </div>
          <button
            type="button"
            tabIndex={-1}
            onClick={onPick}
            className="flex h-12 w-full cursor-pointer items-center justify-center gap-2.5 rounded-full bg-sun text-[0.9375rem] font-[620] text-sun-foreground shadow-[0_8px_24px_-10px_var(--sun)] outline-none transition-[scale,filter] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.98]"
          >
            <Play aria-hidden className="size-4 fill-current" />
            Play
          </button>
        </div>
        {named && <RawNames id={nameId} candidate={candidate} />}
      </div>
    );
  }

  if (compact) {
    const why = candidate.verdict.bucket === "ok" ? null : reasonsLabel(candidate);
    // Size and addon share the first line, so the badges get the second.
    const size = [sizeText(candidate.parsed), bitrateLabel(candidate.parsed, runtime), addon]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="py-0.5">
        <div className="flex items-center gap-1 rounded-xl pe-1 transition-colors active:bg-foreground/5">
          <button
            type="button"
            {...rowProps}
            onClick={onPick}
            aria-describedby={named ? nameId : undefined}
            className="flex min-h-16 min-w-0 flex-1 cursor-pointer flex-col justify-center gap-1 rounded-2xl ps-3 pe-1 py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              {current && <Playing />}
              <span className="min-w-0 truncate font-[550]">
                {quality}
                {source && <span className="ms-2">{source}</span>}
              </span>
              {size && (
                <span className="tnum ms-auto max-w-[55%] shrink-0 truncate text-small text-muted-foreground">
                  {size}
                </span>
              )}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <Badges candidate={candidate} line />
              {why && (
                <>
                  <TriangleAlert
                    aria-hidden
                    className="size-3.5 shrink-0 text-warning-foreground"
                  />
                  <span className="sr-only">{why}</span>
                </>
              )}
            </span>
          </button>
          {fileName}
        </div>
        {named && <RawNames id={nameId} candidate={candidate} />}
      </div>
    );
  }

  if (best) {
    return (
      <div className="py-1 pb-4">
        <div className="relative isolate flex items-center gap-4 overflow-hidden rounded-3xl bg-card p-6 shadow-float hairline before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(80%_140%_at_100%_50%,color-mix(in_srgb,var(--sun)_16%,transparent),transparent_70%)]">
          <button
            type="button"
            {...rowProps}
            onClick={onPick}
            aria-describedby={named ? nameId : undefined}
            className="group/top -m-2 flex min-w-0 flex-1 cursor-pointer items-center gap-6 rounded-2xl p-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 flex-1 flex-col items-start gap-2.5">
              <span className="flex items-center gap-2 text-small font-semibold text-sun-ink">
                <span className="type-eyebrow">Top pick</span>
                {note && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{note}</span>
                  </>
                )}
                {usual && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="flex items-center gap-1">
                      <History aria-hidden className="size-3.5" />
                      Same source as last time
                    </span>
                  </>
                )}
                {current && <span aria-hidden>·</span>}
                {current && <Playing />}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2.5 font-display text-[2.25rem] leading-none">
                <span>{quality}</span>
                {source && <span>{source}</span>}
              </span>
              <Badges candidate={candidate} />
              <Details candidate={candidate} addon={addon} />
            </span>
            <span
              aria-hidden
              className="hidden h-12 shrink-0 items-center gap-2.5 rounded-full bg-sun px-6 text-[0.9375rem] font-[620] text-sun-foreground shadow-[0_8px_24px_-10px_var(--sun)] transition-[scale,filter] duration-(--duration-fast) group-hover/top:brightness-105 sm:flex"
            >
              <Play className="size-4 fill-current" />
              Play
              <Kbd className="bg-sun-foreground/16 text-sun-foreground">P</Kbd>
            </span>
          </button>
          {fileName}
        </div>
        {named && <RawNames id={nameId} candidate={candidate} />}
      </div>
    );
  }

  return (
    <div className="py-0.5">
      <div className="group/stream flex items-center gap-1 rounded-xl pe-3 transition-colors hover:bg-foreground/5">
        <button
          type="button"
          {...rowProps}
          onClick={onPick}
          aria-describedby={named ? nameId : undefined}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 rounded-2xl px-4 py-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
            {current && <Playing />}
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="font-[550]">{quality}</span>
              {source && <span className="font-[550]">{source}</span>}
              {addon && <span className="truncate text-small text-muted-foreground">{addon}</span>}
            </span>
            <Badges candidate={candidate} />
            <Warning candidate={candidate} />
          </span>
          <Facts candidate={candidate} className="shrink-0" />
        </button>
        {fileName}
      </div>
      {named && <RawNames id={nameId} candidate={candidate} />}
    </div>
  );
}

function Playing() {
  return (
    <span className="flex items-center gap-1 text-small font-semibold text-sun-ink">
      <Play aria-hidden className="size-3.5 fill-current" />
      Playing
    </span>
  );
}

// HDR / Dolby Vision, audio and how it plays: neutral, but "Cached", the one
// that plays at once, keeps the brand and its bolt.
function Badges({ candidate, line = false }: { candidate: Candidate; line?: boolean }) {
  const { parsed } = candidate;
  const audio = audioLabel(parsed);
  const codec = videoCodecLabel(parsed);
  const how = delivery(parsed);
  if (parsed.hdr.length === 0 && !codec && !audio && !parsed.atmos && !how) return null;
  const delivered = how && (
    <StreamBadge tone={how.kind === "cached" ? "sun" : "neutral"}>
      {how.kind === "cached" && <Zap aria-hidden className="fill-current" />}
      {how.kind === "uncached" && <Download aria-hidden />}
      {how.kind === "p2p" && <Users aria-hidden />}
      {how.label}
    </StreamBadge>
  );
  return (
    <span
      className={cn(
        "flex items-center gap-1.5",
        // The phone: one line that scrolls sideways, never wrapping (#136),
        // how it plays first and the end faded where it runs on.
        line
          ? "no-scrollbar min-w-0 flex-nowrap overflow-x-auto whitespace-nowrap mask-[linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]"
          : "flex-wrap",
      )}
    >
      {line && delivered}
      {codec && <StreamBadge>{codec}</StreamBadge>}
      {parsed.hdr.map((hdr) => (
        <StreamBadge key={hdr}>{hdr === "DV" ? "Dolby Vision" : hdr}</StreamBadge>
      ))}
      {audio && <StreamBadge>{audio}</StreamBadge>}
      {parsed.atmos && <StreamBadge>Atmos</StreamBadge>}
      {!line && delivered}
    </span>
  );
}

// Why a stream ranks low, if it does.
function Warning({ candidate }: { candidate: Candidate }) {
  const why = candidate.verdict.bucket === "ok" ? null : reasonsLabel(candidate);
  if (!why) return null;
  return (
    <span className="flex items-center gap-1 text-small text-warning-foreground">
      <TriangleAlert aria-hidden className="size-3.5" />
      {why}
    </span>
  );
}

// Size, languages and extra copies, in mono at the end of a row.
function Facts({ candidate, className }: { candidate: Candidate; className?: string }) {
  const { parsed, alternates } = candidate;
  const runtime = useContext(Runtime);
  const facts = [
    sizeText(parsed),
    bitrateLabel(parsed, runtime),
    languagesLabel(parsed),
    alternates.length === 1
      ? "1 more copy"
      : alternates.length > 1
        ? `${alternates.length} more copies`
        : null,
  ].filter(Boolean);
  if (facts.length === 0) return null;
  return (
    <span className={`tnum text-small text-muted-foreground ${className ?? ""}`}>
      {facts.join(" · ")}
    </span>
  );
}

// The top pick's last line: which addon sent it and its facts, and why it
// ranks low, if it does.
function Details({ candidate, addon }: { candidate: Candidate; addon: string }) {
  const { parsed, alternates } = candidate;
  const runtime = useContext(Runtime);
  const facts = [
    addon,
    sizeText(parsed),
    bitrateLabel(parsed, runtime),
    languagesLabel(parsed),
    alternates.length === 1
      ? "1 more copy"
      : alternates.length > 1
        ? `${alternates.length} more copies`
        : null,
  ].filter(Boolean);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted-foreground">
      {facts.length > 0 && <span className="tnum">{facts.join(" · ")}</span>}
      <Warning candidate={candidate} />
    </span>
  );
}

// The file name, only when asked: the parsed names, never the URL, which can
// carry a debrid key.
function RawNames({ id, candidate }: { id: string; candidate: Candidate }) {
  const names = rawNames(candidate.parsed);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div
      id={id}
      className="mx-4 mt-1 mb-2 flex items-start gap-3 rounded-xl bg-muted px-4 py-3 [&_ul]:font-mono"
    >
      {names.length ? (
        <ul className="flex min-w-0 flex-1 flex-col gap-1 tnum text-small break-all">
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : (
        <p className="min-w-0 flex-1 text-body text-muted-foreground">
          The addon doesn’t name the file.
        </p>
      )}
      {names.length > 0 && (
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy file name"}
          title={copied ? "Copied" : "Copy file name"}
          onClick={() =>
            void navigator.clipboard.writeText(names.join("\n")).then(
              () => setCopied(true),
              () => toastManager.add({ type: "error", title: "Couldn’t copy the file name" }),
            )
          }
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? (
            <Check aria-hidden className="size-4" />
          ) : (
            <Copy aria-hidden className="size-4" />
          )}
        </button>
      )}
    </div>
  );
}

// --- Downloading a row (#85) --------------------------------------------------

// Which title and video the picker shows, from its address: /streams/movie/<id>
// with ?video= the episode (or the film itself). Undefined on any other
// screen, such as the player's switcher or the gallery, where a row has no
// title to download from.
type PickerTarget = { type: ContentType; id: string; video: string };

// The picker's two kinds of title: the address's first part, which the pattern
// below matches and the two wait for (ContentType is wider — channels and the
// rest have nothing to download).
function pickerType(part: string | undefined): ContentType | undefined {
  return part === "movie" || part === "series" ? part : undefined;
}

export function pickerOf(pathname: string, search: { video?: unknown }): PickerTarget | undefined {
  const match = /^\/streams\/(movie|series)\/([^/]+)\/?$/.exec(pathname);
  const type = pickerType(match?.[1]);
  if (!match || !type) return undefined;
  const id = decodeURIComponent(match[2]!);
  return {
    type,
    id,
    video: typeof search.video === "string" && search.video ? search.video : id,
  };
}

// What the picker's rows download with: the stream's own link, which is
// already in hand, so nothing is ranked. Null elsewhere.
const RowDownload = createContext<StreamDownloads | null>(null);

// Gives the picker's rows their download menu: the route says which title,
// the details (usually cached by the page) say which addon served it, and the
// profile's downloads say which rows are already downloaded. Anywhere else a
// row has none.
function RowDownloadHost({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useSearch({ strict: false });
  const picker = pickerOf(pathname, search);
  // Asked only where there is a title to download: the player's switcher and
  // the gallery ask nothing.
  const profile = useQuery({ ...currentProfileQuery, enabled: picker !== undefined });
  const profileId = profile.data?.id;
  return picker && profileId !== undefined ? (
    <PickerRowDownloads profileId={profileId} target={picker}>
      {children}
    </PickerRowDownloads>
  ) : (
    <RowDownload value={null}>{children}</RowDownload>
  );
}

function PickerRowDownloads({
  profileId,
  target,
  children,
}: {
  profileId: number;
  target: PickerTarget;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const { addons, loading } = useLoadedAddons(profileId);
  const details = useQuery({
    ...titleMetaQuery(addons, target.type, target.id),
    enabled: !loading,
    // The picker's own details, already asked for and cached by its page.
    ...cachedTitleMeta(client, addons, target.type, target.id),
  });
  const meta = details.data?.meta;
  const addonUrl = details.data?.addonUrl ?? "";
  const video = meta?.videos?.find((each) => each.id === target.video);
  const list = useDownloads(profileId);
  const downloads = useStreamDownloads(
    profileId,
    meta ? downloadTarget(meta, addonUrl, video) : undefined,
    list,
  );
  return (
    <RowDownload value={downloads}>
      {children}
      {downloads.runner}
    </RowDownload>
  );
}

// A stream's own menu: "Download this stream", or that it's already
// downloaded. The menu is the row's, opened by a right-click or, on the
// phone, a long press (#134), so no button crowds the row.
function RowMenu({ candidate, children }: { candidate: Candidate; children: ReactNode }) {
  const downloads = useContext(RowDownload);
  // A torrent, a copy with no link, can't be downloaded at all (ADR-0064).
  if (!downloads || !downloadable(candidate.stream)) return <>{children}</>;
  return (
    <ResponsiveContextMenu
      label={`${resolutionLabel(candidate.parsed) ?? "Stream"} options`}
      popupClassName="material-pop w-60"
      items={
        downloads.has(candidate) ? (
          <ResponsiveMenuItem disabled>
            <Check aria-hidden />
            Downloaded
          </ResponsiveMenuItem>
        ) : (
          <ResponsiveMenuItem disabled={downloads.saving} onClick={() => downloads.save(candidate)}>
            <Download aria-hidden />
            Download this stream
          </ResponsiveMenuItem>
        )
      }
    >
      {children}
    </ResponsiveContextMenu>
  );
}
