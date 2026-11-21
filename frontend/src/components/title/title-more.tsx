import {
  ArrowDown,
  ArrowDownCircle,
  Bookmark,
  BookmarkCheck,
  Eye,
  EyeOff,
  Ellipsis,
  Film,
  RotateCcw,
  Share,
  Star,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type { Profile } from "@bindings/store";
import { RemoveTrackingDialog } from "@/components/media/remove-tracking-dialog";
import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuItem,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuSeparator,
  ResponsiveMenuSub,
} from "@/components/ui/responsive-menu";
import type { Meta, Video } from "@/lib/addon-protocol";
import { downloadState, pressDownload, type TitleDownloads } from "@/lib/download-pick";
import { statusOf, statusText } from "@/lib/downloads";
import { openURL } from "@/lib/open-url";
import { ratingValues, titleRef, useTrackingControls } from "@/lib/tracking";

// A link to the title for the share sheet: IMDb's page when the id is IMDb's.
export const shareURL = (meta: Meta) =>
  /^tt\d+$/.test(meta.id) ? `https://www.imdb.com/title/${meta.id}/` : undefined;

const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

// What the phone's sheet downloads (#85): the same film or next-up episode
// the desktop's round action does, with the addon its details came from.
export type MenuDownload = {
  downloads: TitleDownloads;
  meta: Meta;
  metaAddon: string;
  video?: Video | undefined;
};

// The phone's "•••" on the title page (#136): what doesn't fit the action row.
// It opens #134's bottom sheet: Trailer, Download (#85), the tracking
// watchlist and rating, Mark as watched, and Share.
export function TitleMoreMenu({
  profile,
  meta,
  trailer,
  watched,
  markDisabled,
  onToggleWatched,
  download,
}: {
  profile: Profile;
  meta: Meta;
  trailer: string | undefined;
  watched: boolean;
  markDisabled: boolean;
  onToggleWatched: () => void;
  download?: MenuDownload | undefined;
}) {
  const ref = titleRef(meta, meta.name, meta);
  const { available, statuses, state, setStatus, setRating, warnsOnRemoval } = useTrackingControls(
    profile,
    meta.type,
    ref,
  );
  const [confirming, setConfirming] = useState(false);
  const rating = state?.rating ?? 0;
  const onWatchlist = state?.status === "planned";
  const link = shareURL(meta);

  return (
    <>
      <ResponsiveMenu
        label={meta.name}
        popupClassName="w-60"
        align="end"
        trigger={{
          render: <Button variant="media" size="icon-xl" aria-label="More" />,
          children: <Ellipsis />,
        }}
      >
        {trailer && !profile.kids && (
          <ResponsiveMenuItem onClick={() => void openURL(trailer)}>
            <Film />
            Trailer
          </ResponsiveMenuItem>
        )}
        {download && <DownloadItems download={download} />}
        {available && statuses.includes("planned") && (
          <ResponsiveMenuItem
            disabled={setStatus.isPending}
            onClick={() => {
              if (!onWatchlist) setStatus.mutate("planned");
              // Off the watchlist may clear SIMKL's watch history: confirm.
              else if (warnsOnRemoval) setConfirming(true);
              else setStatus.mutate("none");
            }}
          >
            {onWatchlist ? <BookmarkCheck /> : <Bookmark />}
            {onWatchlist ? "On watchlist" : "Add to watchlist"}
          </ResponsiveMenuItem>
        )}
        {available && (
          <ResponsiveMenuSub
            title="Rate"
            label={
              <>
                <Star className={rating > 0 ? "fill-current" : undefined} />
                {rating > 0 ? `Your rating: ${rating}` : "Rate"}
              </>
            }
          >
            <ResponsiveMenuRadioGroup
              value={String(rating)}
              onValueChange={(next) => setRating.mutate(Number(next))}
            >
              {ratingValues.map((value) => (
                <ResponsiveMenuRadioItem key={value} value={String(value)}>
                  {value}
                </ResponsiveMenuRadioItem>
              ))}
            </ResponsiveMenuRadioGroup>
            {rating > 0 && (
              <>
                <ResponsiveMenuSeparator />
                <ResponsiveMenuItem onClick={() => setRating.mutate(0)}>
                  Clear rating
                </ResponsiveMenuItem>
              </>
            )}
          </ResponsiveMenuSub>
        )}
        <ResponsiveMenuItem disabled={markDisabled} onClick={onToggleWatched}>
          {watched ? <EyeOff /> : <Eye />}
          {watched ? "Mark unwatched" : "Mark watched"}
        </ResponsiveMenuItem>
        {canShare() && (
          <ResponsiveMenuItem
            onClick={() =>
              void navigator.share({ title: meta.name, ...(link && { url: link }) }).catch(() => {})
            }
          >
            <Share />
            Share
          </ResponsiveMenuItem>
        )}
      </ResponsiveMenu>
      <RemoveTrackingDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => setStatus.mutate("none")}
      />
    </>
  );
}

// The sheet's Download row (#85): the film or the episode Play would play,
// its status, and the way back out, as the episode rows have it.
function DownloadItems({ download }: { download: MenuDownload }) {
  const state = downloadState(
    download.downloads,
    download.meta,
    download.metaAddon,
    download.video,
  );
  const { download: record } = state;
  if (!record) {
    const finding = state.control.action === "none";
    return (
      <ResponsiveMenuItem
        disabled={finding}
        onClick={() => pressDownload(state, download.downloads)}
      >
        <ArrowDown />
        {finding ? state.control.label : "Download"}
      </ResponsiveMenuItem>
    );
  }
  const status = statusOf(record);
  return (
    <>
      <ResponsiveMenuItem disabled>
        <ArrowDownCircle />
        {statusText(record)}
      </ResponsiveMenuItem>
      {(status === "paused" || status === "failed") && (
        <ResponsiveMenuItem onClick={() => pressDownload(state, download.downloads)}>
          <RotateCcw />
          Resume download
        </ResponsiveMenuItem>
      )}
      <ResponsiveMenuItem onClick={() => void download.downloads.actions.remove([record.id])}>
        <Trash2 />
        Remove download
      </ResponsiveMenuItem>
    </>
  );
}
