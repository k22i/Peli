import { Link } from "@tanstack/react-router";
import { Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { Artwork } from "@/components/media/artwork";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  downloadLabel,
  formatBytes,
  percent,
  statusOf,
  statusText,
  useDownloadActions,
  useDownloadRate,
  useDownloads,
  type Download,
} from "@/lib/downloads";
import { usePlay } from "@/lib/playback";
import { useOpenTitle } from "@/lib/title";
import { cn } from "@/lib/utils";

// The downloads tray's contents (#85 follow-up): what the shell's download
// button opens, inside a ~24rem popover on the desktop and the iPad and a
// full-width sheet on the iPhone. The shell (part B) owns the material and
// the trigger; this is only what goes in it, so it is a plain div with
// padding.
//
// It is the Library's Downloads view at a glance: the same rows, the same
// actions, and the same rules — an unfinished one is cancelled without
// asking (deleting it takes no connection back), a finished one plays through
// usePlay so a downloaded copy is found offline. What differs is the list: a
// tray shows what is happening now and what finished today, not everything
// ever downloaded (that is what "See all" is for).

// What the tray lists: a finished download stays for a day, so the tray still
// has something to play the evening a film came down.
const recentMs = 24 * 60 * 60 * 1000;

// Downloads the tray lists: everything not done, plus done ones finished
// within the last 24 h, newest first; active (downloading, queued, waiting,
// paused, failed) above done.
export function trayDownloads(list: readonly Download[], now: number): Download[] {
  const cutoff = now - recentMs;
  // The queue as Go runs it (creation order), as the Library view shows it.
  const active = list.filter((download) => statusOf(download) !== "done");
  const done = list
    .filter(
      (download) =>
        statusOf(download) === "done" && (download.doneAt || download.updatedAt) >= cutoff,
    )
    .toSorted((a, b) => (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt));
  return [...active, ...done];
}

// Overall progress of the unfinished ones: sum(bytes)/sum(total) over those
// with a known total, undefined when none is known. The tray's header and the
// button's ring read it.
export function overallPercent(list: readonly Download[]): number | undefined {
  let bytes = 0;
  let total = 0;
  for (const download of list) {
    if (statusOf(download) === "done" || download.total <= 0) continue;
    bytes += download.bytes;
    total += download.total;
  }
  if (total <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((bytes / total) * 100)));
}

export function DownloadTrayList({
  profileId,
  touch,
  onNavigate,
}: {
  profileId: number;
  touch: boolean;
  onNavigate: () => void;
}): ReactNode {
  const downloads = useDownloads(profileId);
  const actions = useDownloadActions(profileId);
  const play = usePlay();
  const open = useOpenTitle();

  const rows = trayDownloads(downloads, Date.now());

  const handlers: TrayHandlers = {
    // The record says what to play: its title, its type and its video, as the
    // Library view's rows do.
    play: (download) => {
      onNavigate();
      play({
        type: download.contentType,
        id: download.contentId,
        title: download.name,
        videoId: download.videoId,
      });
    },
    openTitle: (download) => {
      onNavigate();
      open(
        {
          id: download.contentId,
          type: download.contentType,
          name: download.name,
          poster: download.poster,
        },
        download.season > 0 ? { season: download.season } : {},
      );
    },
    pause: (download) => void actions.pause(download.id),
    resume: (download) => void actions.resume(download.id),
    // Cancelling an unfinished one removes it at once, as the Library view
    // does: nothing has to be fetched again.
    cancel: (download) => void actions.remove([download.id]),
    navigate: onNavigate,
  };

  if (rows.length === 0) {
    return (
      <div data-slot="download-tray" className="flex flex-col gap-2 p-3">
        <Header summary={null} touch={touch} onNavigate={onNavigate} />
        <div className="flex flex-col items-center gap-1 px-2 py-8 text-center">
          <p className="type-item text-foreground">No downloads</p>
          <p className="text-small text-muted-foreground">
            Download a film or an episode from its page or a stream’s menu.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-slot="download-tray" className="flex flex-col gap-2 p-3">
      <Header summary={summaryText(rows)} touch={touch} onNavigate={onNavigate} />
      {/* Six rows of a 24rem popover: past that the list scrolls. */}
      <ul className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
        {rows.map((download) => (
          <Row key={download.id} download={download} touch={touch} handlers={handlers} />
        ))}
      </ul>
    </div>
  );
}

// What a row's controls do to its download.
type TrayHandlers = {
  play: (download: Download) => void;
  openTitle: (download: Download) => void;
  pause: (download: Download) => void;
  resume: (download: Download) => void;
  cancel: (download: Download) => void;
  navigate: () => void;
};

// "Downloads" and how it is going, with the way to the whole list. No summary
// line when the tray is empty (the empty state says it instead).
function Header({
  summary,
  touch,
  onNavigate,
}: {
  summary: string | null;
  touch: boolean;
  onNavigate: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col">
        <h2 className="type-item text-foreground">Downloads</h2>
        {summary !== null && (
          <p className="truncate text-small text-muted-foreground tnum">{summary}</p>
        )}
      </div>
      <Link
        to="/library"
        search={{ view: "downloads" }}
        onClick={onNavigate}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "-me-2 shrink-0",
          touch && "h-11 px-3",
        )}
      >
        See all
      </Link>
    </div>
  );
}

// "2 downloading · 3.1 GB of 7.8 GB": how many are on their way and the share
// of their sizes the totals are known for; "All done" when nothing is.
function summaryText(list: readonly Download[]): string {
  const unfinished = list.filter((download) => statusOf(download) !== "done");
  if (unfinished.length === 0) return "All done";
  const counted = unfinished.filter((download) => download.total > 0);
  const total = counted.reduce((sum, download) => sum + download.total, 0);
  const count = `${unfinished.length} downloading`;
  if (total <= 0) return count;
  const bytes = counted.reduce((sum, download) => sum + download.bytes, 0);
  return `${count} · ${formatBytes(bytes)} of ${formatBytes(total)}`;
}

// One download: its poster, what it is, how far along, and what can be done
// to it. The title is its own button (it opens the title page, never plays),
// so a finished row's Play is the only thing that starts a video.
function Row({
  download,
  touch,
  handlers,
}: {
  download: Download;
  touch: boolean;
  handlers: TrayHandlers;
}) {
  const status = statusOf(download);
  const done = status === "done";
  const failed = status === "failed";
  const label = downloadLabel(download);
  const rate = useDownloadRate(download.id);
  const episodeName =
    download.season > 0 ? download.episodeName || `Episode ${download.episode}` : undefined;
  // A finger needs 44 pt; the desktop's icons stay the size the app uses.
  const iconButton = cn(touch && "size-11");
  return (
    <li
      data-download={download.id}
      className={cn(
        "flex items-start gap-3 rounded-xl p-2",
        touch ? "min-h-11" : "hover:bg-accent/40",
      )}
    >
      <span className="relative aspect-[2/3] w-11 shrink-0 overflow-hidden rounded-md shadow-card">
        <Artwork src={download.poster} use="poster" title={download.name} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          aria-label={`Open ${label}`}
          onClick={() => handlers.openTitle(download)}
          className="min-w-0 cursor-pointer rounded text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="block truncate type-item text-foreground">{download.name}</span>
        </button>
        {episodeName !== undefined && (
          <span className="truncate text-small text-muted-foreground">
            <span className="tnum">{`S${download.season} · E${download.episode}`}</span>
            {` · ${episodeName}`}
          </span>
        )}
        {!done && <ProgressBar value={percent(download)} label={label} />}
        <span className="truncate text-small text-muted-foreground tnum">
          {done
            ? formatBytes(download.total > 0 ? download.total : download.bytes)
            : metaText(download, rate)}
        </span>
      </div>
      {done ? (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            size="sm"
            className={cn(touch && "h-11 px-4")}
            aria-label={`Play ${label}`}
            onClick={() => handlers.play(download)}
          >
            <Play aria-hidden className="fill-current" />
            Play
          </Button>
          <Link
            to="/library"
            search={{ view: "downloads" }}
            onClick={handlers.navigate}
            className={cn(
              "shrink-0 text-small text-muted-foreground underline-offset-4 hover:underline",
              touch ? "flex h-11 items-center" : "px-1",
            )}
          >
            Show in Library
          </Link>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {status === "paused" || failed ? (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              aria-label={`${failed ? "Retry" : "Resume"} ${label}`}
              onClick={() => handlers.resume(download)}
            >
              {failed ? <RotateCcw aria-hidden /> : <Play aria-hidden />}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              aria-label={`Pause ${label}`}
              onClick={() => handlers.pause(download)}
            >
              <Pause aria-hidden />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={iconButton}
            aria-label={`Cancel ${label}`}
            onClick={() => handlers.cancel(download)}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      )}
    </li>
  );
}

// "42 % · 1.2 GB of 2.9 GB · 8.4 MB/s": how far along, how much of the file,
// and how fast — or the state's own words while it isn't running
// ("Waiting for Wi-Fi", "Paused", "Failed: …"). The percent and the size stay
// off until the server has said what the total is.
function metaText(download: Download, rate: number): string {
  const parts: string[] = [];
  const done = percent(download);
  if (done !== undefined) parts.push(`${done} %`);
  if (download.total > 0) {
    parts.push(`${formatBytes(download.bytes)} of ${formatBytes(download.total)}`);
  } else if (download.bytes > 0) {
    parts.push(formatBytes(download.bytes));
  }
  if (statusOf(download) === "downloading") {
    if (rate > 0) parts.push(`${formatBytes(rate)}/s`);
  } else {
    parts.push(statusText(download));
  }
  return parts.join(" · ");
}

// The bar under the title, in the app's amber: quiet enough to sit in a row
// beside the words, and a progressbar to a screen reader. A styled bar rather
// than a form control, so it isn't a <progress>.
function ProgressBar({ value, label }: { value: number | undefined; label: string }) {
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a bar, not a form control.
    <span
      role="progressbar"
      aria-label={`${label} progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? 0}
      className="mt-0.5 block h-1 w-full overflow-hidden rounded-full bg-foreground/12"
    >
      <span className="block h-full rounded-full bg-sun" style={{ width: `${value ?? 0}%` }} />
    </span>
  );
}
