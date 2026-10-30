import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Download, FileText, Play, TriangleAlert, Users, Zap } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { scrollParent } from "@/components/media/poster-grid";
import { prefersReducedMotion } from "@/components/media/roving";
import { Badge } from "@/components/ui/badge";
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
// list pins the top pick, so it doesn't change under the user.

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
const rowPx = { top: 132, group: 52, stream: 76 } as const;

export function StreamList({
  rows,
  names,
  onNavigate,
  onPick,
  onToggleGroup,
}: {
  rows: readonly ListRow[];
  // Addon names, by URL.
  names: ReadonlyMap<string, string>;
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

function GroupHeading({
  row,
  rowProps,
  onToggle,
}: {
  row: Extract<ListRow, { kind: "group" }>;
  rowProps: RowProps;
  onToggle: () => void;
}) {
  const label = (
    <>
      {tierLabel(row.tier)}{" "}
      <span className="font-mono text-meta font-normal text-muted-foreground">{row.count}</span>
    </>
  );
  return (
    <h2 className="pt-5 pb-2 font-heading text-base font-semibold font-stretch-semi-expanded">
      {row.open === null ? (
        <span className="px-3">{label}</span>
      ) : (
        <button
          type="button"
          {...rowProps}
          aria-expanded={row.open}
          onClick={onToggle}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
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
      )}
    </h2>
  );
}

function StreamRow({
  candidate,
  best,
  addon,
  named,
  rowProps,
  onPick,
  onToggleName,
}: {
  candidate: Candidate;
  best: boolean;
  addon: string;
  named: boolean;
  rowProps: RowProps;
  onPick: () => void;
  onToggleName: () => void;
}) {
  const nameId = `stream-name-${rowProps["data-row-index"]}`;
  return (
    <div className={cn("py-1", best && "pb-3")}>
      <div
        className={cn(
          "group/stream flex items-stretch gap-1 rounded-xl transition-colors",
          best ? "border border-brand bg-card shadow-card" : "hover:bg-accent/60",
        )}
      >
        <button
          type="button"
          {...rowProps}
          onClick={onPick}
          aria-describedby={named ? nameId : undefined}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 rounded-xl px-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
            best ? "py-4 ps-4" : "py-2.5",
          )}
        >
          {best && (
            <span className="flex items-center gap-2 text-sm font-semibold text-brand">
              Top pick
            </span>
          )}
          <Badges candidate={candidate} best={best} />
          <Details candidate={candidate} addon={addon} />
        </button>
        <div className="flex shrink-0 items-center gap-2 pe-2">
          {best && (
            <span
              aria-hidden
              className="hidden items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground sm:flex"
            >
              <Play className="size-4 fill-current" />
              Play
              <Kbd className="bg-brand-foreground/16 text-brand-foreground">P</Kbd>
            </span>
          )}
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
              "flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              named && "bg-accent text-foreground",
            )}
          >
            <FileText className="size-4" />
          </button>
        </div>
      </div>
      {named && <RawNames id={nameId} candidate={candidate} />}
    </div>
  );
}

// Resolution, HDR / DV, audio and source: what the picture and sound are.
function Badges({ candidate, best }: { candidate: Candidate; best: boolean }) {
  const { parsed } = candidate;
  const resolution = resolutionLabel(parsed);
  const audio = audioLabel(parsed);
  const source = sourceLabel(parsed);
  const size = best ? "lg" : "default";
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge size={size} variant="secondary" className="font-mono font-semibold">
        {resolution ?? "Unknown quality"}
      </Badge>
      {parsed.hdr.map((hdr) => (
        <Badge key={hdr} size={size} variant="outline" className="font-mono">
          {hdr === "DV" ? "Dolby Vision" : hdr}
        </Badge>
      ))}
      {audio && (
        <Badge size={size} variant="outline" className="font-mono">
          {audio}
        </Badge>
      )}
      {parsed.atmos && (
        <Badge size={size} variant="outline" className="font-mono">
          Atmos
        </Badge>
      )}
      {source && (
        <Badge size={size} variant="outline" className="font-mono">
          {source}
        </Badge>
      )}
    </span>
  );
}

// How it plays, its size and languages, which addon sent it, and why it
// ranks low, if it does.
function Details({ candidate, addon }: { candidate: Candidate; addon: string }) {
  const { parsed, alternates } = candidate;
  const how = delivery(parsed);
  const facts = [
    sizeLabel(parsed.sizeBytes),
    languagesLabel(parsed),
    addon,
    alternates.length === 1
      ? "1 more copy"
      : alternates.length > 1
        ? `${alternates.length} more copies`
        : null,
  ].filter(Boolean);
  const why = candidate.verdict.bucket === "ok" ? null : reasonsLabel(candidate);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-meta text-muted-foreground">
      {how && (
        <span
          className={cn(
            "flex items-center gap-1",
            how.kind === "cached" && "font-medium text-brand",
          )}
        >
          {how.kind === "cached" && <Zap aria-hidden className="size-3.5 fill-current" />}
          {how.kind === "uncached" && <Download aria-hidden className="size-3.5" />}
          {how.kind === "p2p" && <Users aria-hidden className="size-3.5" />}
          {how.label}
        </span>
      )}
      {facts.length > 0 && <span>{facts.join(" · ")}</span>}
      {why && (
        <span className="flex items-center gap-1 text-warning-foreground">
          <TriangleAlert aria-hidden className="size-3.5" />
          {why}
        </span>
      )}
    </span>
  );
}

// The file name, only when asked: the parsed names, never the URL, which can
// carry a debrid key.
function RawNames({ id, candidate }: { id: string; candidate: Candidate }) {
  const names = rawNames(candidate.parsed);
  return (
    <div id={id} className="mx-3 mt-1 mb-2 rounded-lg bg-muted px-3 py-2">
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
