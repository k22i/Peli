import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, Check } from "lucide-react";
import { useEffect, useRef } from "react";

import { DownloadTrayList, overallPercent } from "@/components/downloads/tray-list";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { toastManager } from "@/components/ui/toast";
import { setDownloadTrayOpen, useDownloadTrayOpen } from "@/lib/download-tray";
import {
  downloadLabel,
  statusOf,
  useDownloads,
  type Download,
  type DownloadStatus as DownloadState,
} from "@/lib/downloads";
import { haptic } from "@/lib/haptics";
import { isTouch } from "@/lib/platform";
import { usePlay, type PlayTarget } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";

// The downloads tray's button in the top bar (#85 follow-up, ADR-0064): a
// download's ring beside the profile while jobs run, opening the tray of them
// (a popover on the desktop and the iPad, a bottom sheet on the iPhone), and
// a check with a sun dot once one has finished that the user hasn't looked at
// yet. The open flag is lib/download-tray's, so the stream menu's "Download
// started" toast opens the same tray.
//
// The player screen has no top bar, so mounting the finished watcher here is
// also what keeps it quiet there.

// When the app started and when the tray was last opened. Module scope: the
// top bar mounts again as the shell changes shape (compact and regular on an
// iPad), and a remount must not make an old download new again.
const startedAt = Date.now();
let seenAt = startedAt;

// The ring's circumference, the arc of a circular progress ring in a 28 pt
// viewBox drawn 11 pt out.
const ringLength = 2 * Math.PI * 11;

// A 28 pt round glass button, as the bar's other pills: the finger's target
// grows to 44 pt around it without changing what is drawn.
const glassButton = cn(
  "relative grid size-7 place-items-center rounded-full bg-foreground/8 text-foreground/80 outline-none transition-[background-color,color,scale] duration-(--duration-fast) hover:bg-foreground/14 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-90 data-popup-open:bg-foreground/14 data-popup-open:text-foreground",
  "pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-['']",
);

// "Downloads, 2 in progress, 42 %" while jobs run, "Downloads, 1 finished"
// once they all have and the tray hasn't been looked at since.
function downloadsName(running: number, finished: number, percent: number | undefined): string {
  if (running > 0) {
    return `Downloads, ${running} in progress${percent === undefined ? "" : `, ${percent} %`}`;
  }
  return `Downloads, ${finished} finished`;
}

// Where each download was when the watcher last looked, or null before its
// first look: the app's own list is not news, and only a change to done says
// "Downloaded".
function useFinishedToasts(
  downloads: readonly Download[],
  touch: boolean,
  play: (target: PlayTarget) => void,
): void {
  const before = useRef<Map<string, DownloadState> | null>(null);
  useEffect(() => {
    const last = before.current;
    const statuses = new Map<string, DownloadState>();
    for (const download of downloads) {
      const status = statusOf(download);
      statuses.set(download.id, status);
      if (last === null || last.get(download.id) === status) continue;
      // A download that finished before the app opened already happened.
      if (status !== "done" || download.doneAt <= startedAt) continue;
      if (touch) haptic("success");
      toastManager.add({
        type: "success",
        title: "Downloaded",
        description: downloadLabel(download),
        actionProps: {
          children: "Play",
          onClick: () =>
            play({
              type: download.contentType,
              id: download.contentId,
              title: download.name,
              videoId: download.videoId,
            }),
        },
      });
    }
    before.current = statuses;
  }, [downloads, play, touch]);
}

// The button's face: the progress ring around the arrow while anything is
// downloading, or a check once it is all done, with a sun dot while some of
// it hasn't been seen.
function StatusIcon({
  checked,
  unseen,
  percent,
}: {
  checked: boolean;
  unseen: boolean;
  percent: number | undefined;
}) {
  if (checked) {
    return (
      <>
        <Check aria-hidden className="size-4" strokeWidth={2.5} />
        {unseen && (
          <span
            aria-hidden
            data-slot="download-unseen"
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sun shadow-sun"
          />
        )}
      </>
    );
  }
  // No total is known yet: the ring turns slowly instead, and Reduce Motion
  // leaves it still.
  const unknown = percent === undefined;
  return (
    <>
      <svg
        aria-hidden
        data-slot="download-ring"
        viewBox="0 0 28 28"
        className={cn(
          "absolute inset-0 size-7 -rotate-90",
          unknown &&
            "motion-safe:animate-spin motion-safe:[animation-duration:2.4s] motion-reduce:animate-none",
        )}
      >
        <circle
          cx="14"
          cy="14"
          r="11"
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.22}
          strokeWidth={2}
        />
        <circle
          cx="14"
          cy="14"
          r="11"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={2}
          strokeDasharray={unknown ? `${ringLength / 3} ${ringLength}` : ringLength}
          strokeDashoffset={unknown ? 0 : ringLength * (1 - (percent ?? 0) / 100)}
        />
      </svg>
      <ArrowDown aria-hidden className="relative size-3.5" strokeWidth={2.5} />
    </>
  );
}

export function DownloadStatus() {
  const profileId = useQuery(currentProfileQuery).data?.id;
  const downloads = useDownloads(profileId);
  const open = useDownloadTrayOpen();
  // The iPhone gets a sheet (it can't be a popover there); the desktop and
  // the iPad a popover anchored to the button.
  const sheet = useCompactShell() && isTouch();
  const play = usePlay();

  // Opened is looked at: the badge goes away, and a download that finishes
  // later is unseen again.
  useEffect(() => {
    if (open) seenAt = Date.now();
  }, [open]);

  useFinishedToasts(downloads, sheet, play);

  const running = downloads.filter((download) => statusOf(download) !== "done");
  const finished = downloads.filter((download) => statusOf(download) === "done");
  const unseen = finished.some(
    (download) => download.doneAt > seenAt && download.doneAt > startedAt,
  );
  // Nothing to report and nowhere to go: the bar keeps the profile alone. The
  // tray itself stays mounted so closing it can still animate out.
  const shown = running.length > 0 || unseen || open;

  const percent = overallPercent(downloads);
  const name = downloadsName(running.length, finished.length, percent);
  const icon = <StatusIcon checked={running.length === 0} unseen={unseen} percent={percent} />;
  const close = () => setDownloadTrayOpen(false);

  if (sheet) {
    return (
      <>
        {shown && (
          <button
            type="button"
            aria-label={name}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => {
              haptic("light");
              setDownloadTrayOpen(true);
            }}
            className={glassButton}
          >
            {icon}
          </button>
        )}
        <BottomSheet open={open} onOpenChange={setDownloadTrayOpen} label="Downloads">
          {profileId !== undefined && (
            <DownloadTrayList profileId={profileId} touch onNavigate={close} />
          )}
        </BottomSheet>
      </>
    );
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setDownloadTrayOpen}>
      {shown && (
        <PopoverPrimitive.Trigger aria-label={name} className={glassButton}>
          {icon}
        </PopoverPrimitive.Trigger>
      )}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <PopoverPrimitive.Popup
            aria-label="Downloads"
            data-slot="download-tray-popup"
            className={cn(
              "material-pop w-96 max-w-[calc(100vw-2rem)] origin-(--transform-origin) rounded-2xl p-2 text-popover-foreground shadow-pop outline-none",
              "transition-[scale,opacity] duration-150 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 motion-reduce:transition-opacity",
            )}
          >
            {profileId !== undefined && (
              <DownloadTrayList profileId={profileId} touch={false} onNavigate={close} />
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
