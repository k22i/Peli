import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  Download,
  FileText,
  History,
  Play,
  TriangleAlert,
  Users,
  Zap,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { scrollParent } from "@/components/media/poster-grid";
import { prefersReducedMotion } from "@/components/media/roving";
import { StreamBadge } from "@/components/streams/stream-badge";
import { Kbd } from "@/components/ui/kbd";
import { collapsedTiers, type Candidate, type RankedView, type Tier } from "@/lib/ranking";
import {
  audioLabel,
  delivery,
  languagesLabel,
  rawNames,
  reasonsLabel,
  resolutionLabel,
  sizeLabel,
  sourceLabel,
  tierLabel,
} from "@/lib/stream-labels";
import { cn } from "@/lib/utils";

// The ranked streams (#52): the top pick, then a group per quality, each
// stream told by its badges rather than its file name. The two collapsed
// groups (CAM / TS and likely fakes) open on their heading.
//
// One addon can send over a thousand streams, so the list scrolls with the
// page and is virtualized. It's one Tab stop: the arrow keys, Home and End
// move between rows, Enter plays, I shows a row's file name. Moving into the
// list pins the top pick, so it doesn't change under the user. In the
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

// Where a stuck group heading sits below the title bar.
const stickGap = 8;
const stuckHeight = 48;

export function StreamList({
  rows,
  names,
  onNavigate,
  onPick,
  onToggleGroup,
  playing,
  usual,
}: {
  rows: readonly ListRow[];
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
    return () => observer.disconnect();
  }, []);

  // No React Compiler in this app: nothing here is memoized behind its back.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: (index) => rowPx[rows[index]!.kind],
    // Nothing laid out (jsdom, a hidden page): keep the estimate.
    measureElement: (element) =>
      element.getBoundingClientRect().height ||
      rowPx[rows[Number(element.getAttribute("data-index"))]?.kind ?? "stream"],
    getItemKey: (index) => rowKey(rows[index]!),
    scrollMargin: top,
    overscan: 6,
    initialRect: { width: 0, height: window.innerHeight },
  });
  const items = virtualizer.getVirtualItems();

  // The group whose heading has scrolled up under the title bar stays there,
  // on glass. The list is virtualized, so a heading can't be `sticky` in its
  // own row: this copy is drawn over it instead.
  const [stickAt, setStickAt] = useState(stickGap);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const bar = Number.parseFloat(getComputedStyle(element).getPropertyValue("--titlebar-h"));
    setStickAt((Number.isFinite(bar) ? bar : 0) + stickGap);
  }, []);
  const scrolled = virtualizer.scrollOffset ?? 0;
  // The next heading takes over as it reaches the stuck one.
  const line = scrolled + stickAt + stuckHeight;
  let stuck: Extract<ListRow, { kind: "group" }> | undefined;
  for (let index = 0; index < (scrolled > 0 ? rows.length : 0); index += 1) {
    const row = rows[index]!;
    if (row.kind !== "group") continue;
    if ((virtualizer.measurementsCache[index]?.start ?? Number.POSITIVE_INFINITY) >= line) break;
    stuck = row;
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
    <div className="relative">
      {stuck && (
        // For the pointer only: the real heading, in the list, is the one
        // the keyboard and screen readers use.
        <div aria-hidden className="pointer-events-none sticky top-(--titlebar-h) z-10 h-0">
          <div className="scroll-edge-top absolute inset-x-0 top-2 px-gutter">
            <GroupHeading row={stuck} stuck onToggle={() => onToggleGroup(stuck.tier)} />
          </div>
        </div>
      )}
      <ol
        ref={list}
        aria-label="Streams"
        className="relative px-gutter"
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
              className="absolute inset-x-gutter top-0"
              style={{ transform: `translateY(${item.start - top}px)` }}
            >
              {row.kind === "group" ? (
                <GroupHeading
                  row={row}
                  rowProps={rowProps}
                  onToggle={() => onToggleGroup(row.tier)}
                />
              ) : (
                <StreamRow
                  candidate={row.candidate}
                  best={row.kind === "top"}
                  usual={row.kind === "top" && (usual?.(row.candidate) ?? false)}
                  current={playing?.(row.candidate) ?? false}
                  addon={names.get(row.candidate.source) ?? ""}
                  named={named.has(key)}
                  rowProps={rowProps}
                  onPick={() => onPick(row.candidate)}
                  onToggleName={() => toggleName(key)}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

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
// collapsed groups are a button that opens them. `stuck` is the copy that
// stays under the title bar, on glass: for the pointer only, so it leaves
// the tab order.
function GroupHeading({
  row,
  rowProps,
  stuck = false,
  onToggle,
}: {
  row: Extract<ListRow, { kind: "group" }>;
  rowProps?: RowProps;
  stuck?: boolean;
  onToggle: () => void;
}) {
  const label = (
    <>
      {tierLabel(row.tier)}{" "}
      <span className="font-mono text-meta font-normal text-muted-foreground tabular-nums">
        {row.count}
      </span>
    </>
  );
  const inner =
    row.open === null ? (
      <span className="block px-4 py-1.5">{label}</span>
    ) : (
      <button
        type="button"
        {...rowProps}
        {...(stuck && { tabIndex: -1 })}
        aria-expanded={row.open}
        onClick={onToggle}
        className="pointer-events-auto flex w-full cursor-pointer items-center gap-2 rounded-xl px-4 py-1.5 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 text-muted-foreground transition-transform duration-fast ease-smooth",
            row.open && "rotate-90",
          )}
        />
        <span>{label}</span>
        <span className="ms-auto font-sans text-sm font-normal text-muted-foreground font-stretch-normal">
          {groupNotes[row.tier]}
        </span>
      </button>
    );
  const type = "font-heading text-base font-semibold font-stretch-semi-expanded";
  if (stuck) {
    return <div className={`glass pointer-events-auto rounded-2xl p-1 ${type}`}>{inner}</div>;
  }
  return <h2 className={`pt-6 pb-1 ${type}`}>{inner}</h2>;
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
  candidate,
  best,
  usual,
  current,
  addon,
  named,
  rowProps,
  onPick,
  onToggleName,
}: {
  candidate: Candidate;
  best: boolean;
  usual: boolean;
  current: boolean;
  addon: string;
  named: boolean;
  rowProps: RowProps;
  onPick: () => void;
  onToggleName: () => void;
}) {
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
        "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        named && "bg-accent text-foreground",
      )}
    >
      <FileText className="size-4" />
    </button>
  );

  if (best) {
    return (
      <div className="py-1 pb-4">
        <div className="glass relative flex items-center gap-4 rounded-3xl border-[1.5px] border-brand p-5">
          <button
            type="button"
            {...rowProps}
            onClick={onPick}
            aria-describedby={named ? nameId : undefined}
            className="-m-2 flex min-w-0 flex-1 cursor-pointer items-center gap-6 rounded-2xl p-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 flex-1 flex-col items-start gap-2.5">
              <span className="flex items-center gap-2 text-meta font-semibold text-brand">
                <span className="tracking-[0.06em] uppercase">Top pick</span>
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
              <span className="flex flex-wrap items-baseline gap-x-2 font-heading text-heading">
                <span>{quality}</span>
                {source && <span>{source}</span>}
              </span>
              <Badges candidate={candidate} />
              <Details candidate={candidate} addon={addon} />
            </span>
            <span
              aria-hidden
              className="hidden h-11 shrink-0 items-center gap-2 rounded-full bg-brand px-5 text-base font-semibold text-brand-foreground sm:flex"
            >
              <Play className="size-4 fill-current" />
              Play
              <Kbd className="bg-brand-foreground/16 text-brand-foreground">P</Kbd>
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
      <div className="group/stream flex items-center gap-1 rounded-2xl pe-3 transition-colors hover:bg-accent/60">
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
              {addon && <span className="truncate text-sm text-muted-foreground">{addon}</span>}
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
    <span className="flex items-center gap-1 text-meta font-semibold text-brand">
      <Play aria-hidden className="size-3.5 fill-current" />
      Playing
    </span>
  );
}

// HDR / Dolby Vision, audio and how it plays: neutral, but "Cached", the one
// that plays at once, keeps the brand and its bolt.
function Badges({ candidate }: { candidate: Candidate }) {
  const { parsed } = candidate;
  const audio = audioLabel(parsed);
  const how = delivery(parsed);
  if (parsed.hdr.length === 0 && !audio && !parsed.atmos && !how) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {parsed.hdr.map((hdr) => (
        <StreamBadge key={hdr}>{hdr === "DV" ? "Dolby Vision" : hdr}</StreamBadge>
      ))}
      {audio && <StreamBadge>{audio}</StreamBadge>}
      {parsed.atmos && <StreamBadge>Atmos</StreamBadge>}
      {how && (
        <StreamBadge tone={how.kind === "cached" ? "brand" : "neutral"}>
          {how.kind === "cached" && <Zap aria-hidden className="fill-current" />}
          {how.kind === "uncached" && <Download aria-hidden />}
          {how.kind === "p2p" && <Users aria-hidden />}
          {how.label}
        </StreamBadge>
      )}
    </span>
  );
}

// Why a stream ranks low, if it does.
function Warning({ candidate }: { candidate: Candidate }) {
  const why = candidate.verdict.bucket === "ok" ? null : reasonsLabel(candidate);
  if (!why) return null;
  return (
    <span className="flex items-center gap-1 text-meta text-warning-foreground">
      <TriangleAlert aria-hidden className="size-3.5" />
      {why}
    </span>
  );
}

// Size, languages and extra copies, in mono at the end of a row.
function Facts({ candidate, className }: { candidate: Candidate; className?: string }) {
  const { parsed, alternates } = candidate;
  const facts = [
    sizeLabel(parsed.sizeBytes),
    languagesLabel(parsed),
    alternates.length === 1
      ? "1 more copy"
      : alternates.length > 1
        ? `${alternates.length} more copies`
        : null,
  ].filter(Boolean);
  if (facts.length === 0) return null;
  return (
    <span className={`font-mono text-meta tabular-nums text-muted-foreground ${className ?? ""}`}>
      {facts.join(" · ")}
    </span>
  );
}

// The top pick's last line: which addon sent it and its facts, and why it
// ranks low, if it does.
function Details({ candidate, addon }: { candidate: Candidate; addon: string }) {
  const { parsed, alternates } = candidate;
  const facts = [
    addon,
    sizeLabel(parsed.sizeBytes),
    languagesLabel(parsed),
    alternates.length === 1
      ? "1 more copy"
      : alternates.length > 1
        ? `${alternates.length} more copies`
        : null,
  ].filter(Boolean);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
      {facts.length > 0 && <span className="font-mono tabular-nums">{facts.join(" · ")}</span>}
      <Warning candidate={candidate} />
    </span>
  );
}

// The file name, only when asked: the parsed names, never the URL, which can
// carry a debrid key.
function RawNames({ id, candidate }: { id: string; candidate: Candidate }) {
  const names = rawNames(candidate.parsed);
  return (
    <div id={id} className="mx-4 mt-1 mb-2 rounded-xl bg-muted px-4 py-3">
      {names.length ? (
        <ul className="flex flex-col gap-1 font-mono text-meta break-all">
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">The addon doesn’t name the file.</p>
      )}
    </div>
  );
}
