import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Download as DownloadIcon,
  EllipsisVertical,
  Pause,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { LibraryNotice } from "@/components/library/notice";
import { Artwork } from "@/components/media/artwork";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuItem,
  ResponsiveMenuSeparator,
} from "@/components/ui/responsive-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  downloadLabel,
  downloadsQuery,
  formatBytes,
  percent,
  statusOf,
  statusText,
  useDownloadActions,
  useDownloadRate,
  useDownloadUsage,
  type Download,
  type Usage,
} from "@/lib/downloads";
import { useFeature } from "@/lib/features";
import { usePlay } from "@/lib/playback";
import { clickKind, selectRange, toggleKey } from "@/lib/selection";
import { useCompactShell } from "@/lib/shell-mode";
import { revealPx, slopPx, swipeEnd, swipeOffset } from "@/lib/swipe-row";
import { useOpenTitle } from "@/lib/title";
import { cn } from "@/lib/utils";
import type { Profile } from "@bindings/store";

// The Library's Downloads view (#85, ADR-0064): what this profile has
// downloaded and what is on its way, under a line saying how much room the
// device has left. Rows follow the Upcoming view's — a w-24 poster, the
// title, the episode's code and name, then the stream and how far along it
// is. A finished row plays on click, which goes the way every Play goes
// (lib/playback), so the picker finds the local copy first and offline works.
//
// On the desktop ⌘/Shift-click selects several rows and the bar at the foot
// deletes them together, as the Titles view's does (lib/selection, gated by
// feature("multiSelect")); on the iPhone the rows are Upcoming's compact ones
// with a menu, and a swipe left deletes one. A finished download always asks
// before it goes — it takes a connection to fetch it again — while cancelling
// an unfinished one doesn't.

export function Downloads({ profile }: { profile: Profile }) {
  const list = useQuery(downloadsQuery(profile.id));
  const usage = useDownloadUsage();
  const actions = useDownloadActions(profile.id);
  const compact = useCompactShell();
  // Not on the iPhone (ADR-0055, #138): there is no Shift or ⌘ there.
  const multi = useFeature("multiSelect");
  const play = usePlay();
  const open = useOpenTitle();

  // The selection, as far as the list still shows it: a row that finished or
  // was deleted drops out of it.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  // The downloads whose deletion asked first (the finished ones).
  const [confirming, setConfirming] = useState<readonly Download[] | undefined>();

  const downloads = list.data ?? [];
  const ids = downloads.map((download) => download.id);
  const selected = new Set(ids.filter((id) => chosen.has(id)));
  const picked = downloads.filter((download) => selected.has(download.id));
  const selecting = selected.size > 0;
  const clear = () => {
    setChosen(new Set());
    setAnchor(undefined);
  };

  const remove = (items: readonly Download[]) => {
    // What went is no longer selected, whatever the rows do next.
    clear();
    void actions.remove(items.map((download) => download.id));
  };
  // Finished downloads ask first; cancelling what hasn't finished doesn't.
  const ask = (items: readonly Download[]) => {
    if (items.length === 0) return;
    if (items.some((download) => statusOf(download) === "done")) setConfirming(items);
    else remove(items);
  };

  const handlers: RowHandlers = {
    // The record says what to play: its title, its type and its video.
    play: (download) =>
      play({
        type: download.contentType,
        id: download.contentId,
        title: download.name,
        videoId: download.videoId,
      }),
    goToTitle: (download) =>
      open(
        {
          id: download.contentId,
          type: download.contentType,
          name: download.name,
          poster: download.poster,
        },
        download.season > 0 ? { season: download.season } : {},
      ),
    pause: (download) => void actions.pause(download.id),
    resume: (download) => void actions.resume(download.id),
    remove: (download) => ask([download]),
  };

  // The selection's row actions: ⌘-click toggles one, Shift-click takes the
  // range from the anchor, and Delete removes the row (or the whole
  // selection, when the row is in it).
  const rowSelection = (download: Download) => ({
    toggle: () => {
      setChosen(toggleKey(selected, download.id));
      setAnchor(download.id);
    },
    extend: () => setChosen(new Set([...selected, ...selectRange(ids, anchor, download.id)])),
    remove: () => ask(selected.has(download.id) ? picked : [download]),
  });

  // ⌘A and Esc work from anywhere on the page, not only on a row; a menu or
  // dialog that is open keeps them for itself.
  useEffect(() => {
    if (!multi) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || inOverlay(event.target)) return;
      if (event.key === "Escape" && selecting) {
        event.preventDefault();
        clear();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        if (editable(event.target)) return;
        event.preventDefault();
        setChosen(new Set(ids));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (list.isPending) return <DownloadsSkeleton />;
  if (list.isError) {
    return (
      <LibraryNotice
        icon={DownloadIcon}
        title="Couldn’t load your downloads"
        description="Something went wrong reading them from this device."
        action={<Button onClick={() => void list.refetch()}>Try again</Button>}
      />
    );
  }
  // Kids profiles see this too: a kids profile downloads what it may watch.
  if (downloads.length === 0) {
    return (
      <LibraryNotice
        icon={DownloadIcon}
        title="No downloads yet"
        description="Download films and episodes from their page to watch them without a connection."
      />
    );
  }

  const { active, done } = groupDownloads(downloads);
  const row = (download: Download) =>
    compact ? (
      <CompactRow key={download.id} download={download} handlers={handlers} />
    ) : (
      <DesktopRow
        key={download.id}
        download={download}
        selected={selected.has(download.id)}
        multi={multi}
        selecting={selecting}
        selection={rowSelection(download)}
        handlers={handlers}
      />
    );

  return (
    <>
      <div className={cn("flex flex-col px-page", compact ? "gap-4" : "max-w-4xl gap-8")}>
        {active.length > 0 && <Group title="Downloading">{active.map(row)}</Group>}
        {done.length > 0 && <Group title="Downloaded">{done.map(row)}</Group>}
        <StorageLine usage={usage} />
      </div>
      {selecting && !compact && (
        <DownloadSelectionBar count={selected.size} onDelete={() => ask(picked)} onDone={clear} />
      )}
      <DeleteDialog
        items={confirming}
        onCancel={() => setConfirming(undefined)}
        onConfirm={(items) => {
          setConfirming(undefined);
          remove(items);
        }}
      />
    </>
  );
}

// What a row's buttons do to its download.
type RowHandlers = {
  play: (download: Download) => void;
  goToTitle: (download: Download) => void;
  pause: (download: Download) => void;
  resume: (download: Download) => void;
  remove: (download: Download) => void;
};

// The list, as the view shows it: what hasn't finished (the queue, in the
// order Go runs it) and then what has, most recently downloaded first.
function groupDownloads(list: readonly Download[]): { active: Download[]; done: Download[] } {
  return {
    active: list.filter((download) => statusOf(download) !== "done"),
    done: list
      .filter((download) => statusOf(download) === "done")
      .toSorted((a, b) => (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt)),
  };
}

// A group of rows under its heading: the desktop's display-serif one, or the
// iPhone's 13 pt uppercase label (#132), as Upcoming's days are.
function Group({ title, children }: { title: string; children: ReactNode }) {
  const compact = useCompactShell();
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2
        className={
          compact
            ? "flex min-h-9 items-center text-[0.8125rem] font-[590] tracking-[0.06em] text-muted-foreground uppercase"
            : "flex items-baseline gap-3 py-2.5 font-display text-[1.75rem] leading-none"
        }
      >
        {title}
      </h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

// One download on the desktop: the poster and what it is as one button (it
// plays when it's done, and opens its title until then), then the actions
// that apply to its state.
function DesktopRow({
  download,
  selected,
  multi,
  selecting,
  selection,
  handlers,
}: {
  download: Download;
  selected: boolean;
  multi: boolean;
  selecting: boolean;
  selection: { toggle: () => void; extend: () => void; remove: () => void };
  handlers: RowHandlers;
}) {
  const status = statusOf(download);
  const done = status === "done";
  const failed = status === "failed";
  const label = downloadLabel(download);
  return (
    <li
      data-download={download.id}
      data-selected={selected || undefined}
      className={cn(
        "flex items-center gap-3 rounded-2xl p-3 transition-colors",
        selected ? "bg-accent/70" : "hover:bg-accent/40",
      )}
    >
      <button
        type="button"
        aria-label={done ? `Play ${label}` : `Go to ${label}`}
        onClick={(event) => {
          const kind = multi ? clickKind(event, selecting) : "open";
          if (kind === "toggle") selection.toggle();
          else if (kind === "range") selection.extend();
          else if (done) handlers.play(download);
          else handlers.goToTitle(download);
        }}
        onKeyDown={(event) => {
          if (!multi) return;
          if (event.key === " ") {
            event.preventDefault();
            if (event.shiftKey) selection.extend();
            else selection.toggle();
          } else if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            selection.remove();
          }
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-5 rounded-xl text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-lg shadow-card">
          <Artwork src={download.poster} use="poster" title={download.name} showTitle />
        </span>
        <RowText download={download} />
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {done ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => handlers.goToTitle(download)}>
              Go to title
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${label}`}
              onClick={() => handlers.remove(download)}
            >
              <Trash2 aria-hidden />
            </Button>
          </>
        ) : (
          <>
            {status === "paused" || failed ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${failed ? "Retry" : "Resume"} ${label}`}
                onClick={() => handlers.resume(download)}
              >
                {failed ? <RotateCcw aria-hidden /> : <Play aria-hidden />}
                {failed ? "Retry" : "Resume"}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Pause ${label}`}
                onClick={() => handlers.pause(download)}
              >
                <Pause aria-hidden />
                Pause
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Cancel ${label}`}
              onClick={() => handlers.remove(download)}
            >
              <Trash2 aria-hidden />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

// One download on the iPhone (#132): Upcoming's compact row, its menu at the
// end (a sheet, #134), and a swipe left on the row itself to delete it, as a
// recent search is deleted (#137, lib/swipe-row). The handlers are on the row's
// button, the one element a finger lands on, and the menu moves with it.
function CompactRow({ download, handlers }: { download: Download; handlers: RowHandlers }) {
  const status = statusOf(download);
  const done = status === "done";
  const failed = status === "failed";
  const label = downloadLabel(download);
  const row = useRef<HTMLLIElement>(null);
  const gesture = useRef<{
    x: number;
    t: number;
    from: number;
    swiping: boolean;
    velocity: number;
  }>(undefined);
  const [drag, setDrag] = useState<number>();
  // Open shows the Delete button behind the row, one row at a time.
  const [open, setOpen] = useState(false);
  const offset = drag ?? (open ? -revealPx : 0);
  const width = () => row.current?.offsetWidth ?? 320;
  // The click that ends a swipe isn't a tap on the row.
  const swiped = useRef(false);
  return (
    <li ref={row} className="relative overflow-hidden">
      <button
        type="button"
        aria-label={`Delete ${label}`}
        tabIndex={open ? 0 : -1}
        className="absolute inset-y-0 end-0 flex items-center justify-center bg-destructive text-small font-[590] text-white outline-none"
        style={{ width: Math.max(revealPx, -offset) }}
        onClick={() => handlers.remove(download)}
      >
        Delete
      </button>
      <div
        className="relative flex touch-pan-y items-center gap-2 bg-background px-3"
        style={{
          transform: `translateX(${offset}px)`,
          transition:
            drag === undefined ? "transform 0.28s var(--ease-out-soft, ease-out)" : "none",
        }}
      >
        <button
          type="button"
          aria-label={done ? `Play ${label}` : `Go to ${label}`}
          onClick={() => {
            if (swiped.current) {
              swiped.current = false;
              return;
            }
            if (open) {
              setOpen(false);
              return;
            }
            if (done) handlers.play(download);
            else handlers.goToTitle(download);
          }}
          onPointerDown={(event) => {
            swiped.current = false;
            if (event.pointerType === "mouse") return;
            gesture.current = {
              x: event.clientX,
              t: event.timeStamp,
              from: open ? -revealPx : 0,
              swiping: false,
              velocity: 0,
            };
          }}
          onPointerMove={(event) => {
            const current = gesture.current;
            if (!current) return;
            const dx = event.clientX - current.x;
            if (!current.swiping) {
              if (Math.abs(dx) < slopPx) return;
              current.swiping = true;
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            const next = swipeOffset(current.from, dx, width());
            const dt = Math.max(1, event.timeStamp - current.t);
            current.velocity = ((event.clientX - current.x) / dt) * 1000;
            setDrag(next);
          }}
          onPointerUp={() => {
            const current = gesture.current;
            gesture.current = undefined;
            if (!current?.swiping || drag === undefined) return;
            swiped.current = true;
            const end = swipeEnd(drag, current.velocity, width());
            setDrag(undefined);
            if (end === "delete") handlers.remove(download);
            else setOpen(end === "open");
          }}
          onPointerCancel={() => {
            gesture.current = undefined;
            setDrag(undefined);
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl py-2 text-start outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="relative h-[4.125rem] w-11 shrink-0 overflow-hidden rounded-md shadow-card">
            <Artwork src={download.poster} use="poster" title={download.name} showTitle />
          </span>
          <RowText download={download} compact />
        </button>
        <ResponsiveMenu
          label={label}
          header={label}
          align="end"
          trigger={{
            render: (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`More for ${label}`}
                className="size-11 shrink-0 rounded-full"
              />
            ),
            children: <EllipsisVertical aria-hidden />,
          }}
        >
          {done ? (
            <ResponsiveMenuItem onClick={() => handlers.play(download)}>
              <Play aria-hidden className="fill-current" />
              Play
            </ResponsiveMenuItem>
          ) : status === "paused" || failed ? (
            <ResponsiveMenuItem onClick={() => handlers.resume(download)}>
              <RotateCcw aria-hidden />
              {failed ? "Retry" : "Resume"}
            </ResponsiveMenuItem>
          ) : (
            <ResponsiveMenuItem onClick={() => handlers.pause(download)}>
              <Pause aria-hidden />
              Pause
            </ResponsiveMenuItem>
          )}
          <ResponsiveMenuItem onClick={() => handlers.goToTitle(download)}>
            Go to title
          </ResponsiveMenuItem>
          <ResponsiveMenuSeparator />
          <ResponsiveMenuItem variant="destructive" onClick={() => handlers.remove(download)}>
            <Trash2 aria-hidden />
            {done ? "Delete" : "Cancel download"}
          </ResponsiveMenuItem>
        </ResponsiveMenu>
      </div>
    </li>
  );
}

// A download's title, its code and name when it's an episode, the stream, and
// where it is. On the iPhone the last two share one line, as Upcoming's rows
// do.
function RowText({ download, compact = false }: { download: Download; compact?: boolean }) {
  const status = statusOf(download);
  // What has bytes to show: a job that is running, held or paused.
  const running = status === "downloading" || status === "paused" || status === "waiting";
  const rate = useDownloadRate(download.id);
  const code = download.season > 0 ? `S${download.season} · E${download.episode}` : undefined;
  const episode = download.season > 0 ? download.episodeName || `Episode ${download.episode}` : "";
  const size = formatBytes(download.total > 0 ? download.total : download.bytes);
  const stream = download.resolution ? `${download.resolution} · ${size}` : size;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span
        className={cn(
          "truncate text-foreground",
          compact ? "text-[0.9375rem] leading-[1.25] font-semibold" : "type-item",
        )}
      >
        {download.name}
      </span>
      {code && (
        <span
          className={cn(
            "truncate text-muted-foreground",
            compact ? "text-[0.8125rem] leading-[1.3]" : "text-body",
          )}
        >
          <span className="tnum text-small">{code}</span> · {episode}
        </span>
      )}
      {compact ? (
        <span className="truncate text-[0.8125rem] leading-[1.3] text-muted-foreground">
          {statusText(download)}
          {" · "}
          {running ? progressText(download, rate) : stream}
        </span>
      ) : (
        <>
          <span className="truncate text-small text-muted-foreground tnum">{stream}</span>
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-small">
            <span className="text-muted-foreground">{statusText(download)}</span>
            {running && (
              <span className="text-muted-foreground tnum">{progressText(download, rate)}</span>
            )}
          </span>
        </>
      )}
      {running && <ProgressBar value={percent(download)} />}
    </span>
  );
}

// "1.2 GB of 3.4 GB · 5.2 MB/s": the bytes of the total the server gave, and
// the speed downloads:progress last reported (lib/downloads' rate map). The
// size alone while the total isn't known yet.
function progressText(download: Download, rate: number): string {
  const size =
    download.total > 0
      ? `${formatBytes(download.bytes)} of ${formatBytes(download.total)}`
      : formatBytes(download.bytes);
  return rate > 0 ? `${size} · ${formatBytes(rate)}/s` : size;
}

function ProgressBar({ value }: { value: number | undefined }) {
  return (
    <span
      aria-hidden
      data-slot="download-progress"
      className="mt-0.5 block h-1 w-full overflow-hidden rounded-full bg-foreground/12"
    >
      <span
        className="block h-full rounded-full bg-foreground/60"
        style={{ width: `${value ?? 0}%` }}
      />
    </span>
  );
}

// How much of the device's cap the downloads take, and the room left beside
// it, with the way to Settings › Downloads (`?section=downloads`, which
// components/settings/panes.ts names) at its end.
function StorageLine({ usage }: { usage: Usage | undefined }) {
  if (!usage) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-small text-muted-foreground tnum">
        {formatBytes(usage.used)} of {formatBytes(usage.cap)} used · {formatBytes(usage.free)} free
      </p>
      <Link
        to="/settings"
        search={{ section: "downloads" }}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-me-2")}
      >
        Settings › Downloads
      </Link>
    </div>
  );
}

// The bar the desktop rises over the page while rows are selected: how many,
// what can be done to them all, and Done (the Titles view's bar).
function DownloadSelectionBar({
  count,
  onDelete,
  onDone,
}: {
  count: number;
  onDelete: () => void;
  onDone: () => void;
}) {
  return (
    <div
      data-slot="selection-bar"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center px-page"
    >
      <div
        role="toolbar"
        aria-label="Selection"
        className="material-pop pointer-events-auto flex flex-wrap items-center gap-1 rounded-full p-1.5 ps-5"
      >
        <output className="me-2 type-item tnum">{count} selected</output>
        <Button variant="ghost" onClick={onDelete}>
          <Trash2 />
          Delete
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

// Deleting a finished download asks first: downloading it again takes a
// connection. (Cancelling one that hasn't finished doesn't get this far.)
function DeleteDialog({
  items,
  onCancel,
  onConfirm,
}: {
  items: readonly Download[] | undefined;
  onCancel: () => void;
  onConfirm: (items: readonly Download[]) => void;
}) {
  const one = items?.length === 1 ? items[0] : undefined;
  return (
    <AlertDialog open={items !== undefined} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {one ? `Delete ${downloadLabel(one)}?` : `Delete ${items?.length ?? 0} downloads?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {one
              ? "You’ll need a connection to download it again."
              : "You’ll need a connection to download them again."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={() => items && onConfirm(items)}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

// Two groups' worth of rows, as tall as the real ones (p-3 around a w-24
// poster; a 44×66 one on the iPhone).
function DownloadsSkeleton() {
  const compact = useCompactShell();
  return (
    <div aria-hidden className={cn("flex flex-col px-page", compact ? "gap-3" : "max-w-4xl gap-2")}>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className={cn("flex items-center gap-5", compact ? "gap-3 py-2" : "p-3")}>
          <Skeleton
            className={compact ? "h-[4.125rem] w-11 rounded-md" : "aspect-[2/3] w-24 rounded-lg"}
          />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-48 rounded" />
            <Skeleton className="h-4 w-72 max-w-full rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Whether keys go to a text field, which keeps ⌘A for its own text.
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// Whether an open menu, dialog or listbox popup owns the key.
const inOverlay = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest("[role=menu], [role=dialog], [role=listbox][data-popup]") !== null;
