import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowDownCircle,
  ArrowUpRight,
  Eye,
  EyeOff,
  Link as LinkIcon,
  ListVideo,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { Profile, Progress } from "@bindings/store";
import { RemoveTrackingDialog } from "@/components/media/remove-tracking-dialog";
import { TitleMenuExtras } from "@/components/media/title-menu-extras";
import {
  ResponsiveContextMenu,
  ResponsiveMenuGroup,
  ResponsiveMenuItem,
  ResponsiveMenuSeparator,
} from "@/components/ui/responsive-menu";
import { toastManager } from "@/components/ui/toast";
import type { Meta } from "@/lib/addon-protocol";
import { viaProxy } from "@/lib/artwork-url";
import {
  downloadRows,
  downloadState,
  pressDownload,
  useDownloadQueue,
  useTitleDownloadsWith,
  videoToDownload,
  type DownloadQueue,
  type TitleDownloads,
} from "@/lib/download-pick";
import { useLoadedAddons } from "@/lib/home";
import { libraryQuery } from "@/lib/library";
import { streamsPath, streamsSearch, usePlay } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import {
  cachedTitleMeta,
  episodeMarks,
  episodes as episodesOf,
  isSeriesType,
  libraryItem,
  mainEpisodes,
  playChoice,
  titleMark,
  titleMetaQuery,
  titleProgressQuery,
  titleState,
  titleWatchedQuery,
  useOpenTitle,
} from "@/lib/title";
import { imdbIdOf, imdbUrl, useTitleEdits, type MenuTitle } from "@/lib/title-actions";

// The right-click menu of a title wherever its card shows (Home, Browse,
// Search, folders, the library): Play or Resume, its page, the library,
// watched, the stream picker, its IMDb link, and its download (#85).
// `children` is the card; the context-menu key and Shift+F10 open it too (see
// `openOnContextKey`), and closing it hands the focus back to the card.
// Groups from other features go in TitleMenuExtras. Everything but the card's
// own preview is read when the menu opens, so a screen of cards costs
// nothing — and the download it starts outlives the menu, since the queue is
// the card's.
export function TitleMenu({
  title,
  items,
  children,
}: {
  title: MenuTitle;
  // Shown in place of the title's own items (and TitleMenuExtras), for a
  // card that stands for more than itself, as one in a selection does.
  items?: ReactNode | undefined;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLDivElement>(null);
  // What to do once the user agrees to a question the menu asked. The dialog
  // is here, not in the popup, which unmounts when an item is chosen.
  const [asked, setAsked] = useState<{ run: () => void }>();
  // The download queue lives on the card, not in the popup (#85): choosing
  // Download closes the menu, and the ranking goes on. The rest of the
  // downloads (the records, the actions) are read by the menu while it's open.
  const profile = useQuery(currentProfileQuery).data;
  const queue = useDownloadQueue(profile?.id);
  return (
    <>
      <ResponsiveContextMenu
        triggerRef={trigger}
        label={title.name}
        header={<TitleSheetHeader title={title} />}
        popupClassName="material-pop w-60"
        // Not the trigger, which is a layout-less wrapper: the card in it.
        finalFocus={() => focusTarget(trigger.current)}
        items={
          items ?? (
            <TitleMenuItems
              title={title}
              queue={queue}
              confirm={(run) => setAsked({ run })}
            />
          )
        }
      >
        {children}
      </ResponsiveContextMenu>
      <RemoveTrackingDialog
        open={asked !== undefined}
        onOpenChange={(open) => !open && setAsked(undefined)}
        onConfirm={() => asked?.run()}
        finalFocus={() => focusTarget(trigger.current)}
      />
      {queue.runner}
    </>
  );
}

// The top of a title's sheet on the iPhone, like the preview over an iOS
// context menu: the poster small, the title and its year.
export function TitleSheetHeader({
  title,
}: {
  title: { name: string; poster?: string | undefined; releaseInfo?: string | undefined };
}) {
  return (
    <div className="flex items-center gap-3 border-b px-5 pb-3">
      {title.poster ? (
        <img
          src={viaProxy(title.poster)}
          alt=""
          className="aspect-2/3 w-11 shrink-0 rounded-md bg-foreground/8 object-cover"
        />
      ) : (
        <span aria-hidden className="aspect-2/3 w-11 shrink-0 rounded-md bg-foreground/8" />
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="line-clamp-2 text-[17px] leading-[22px] font-[620] tracking-[-0.01em]">
          {title.name}
        </span>
        {title.releaseInfo && (
          <span className="text-[15px] leading-5 text-muted-foreground tnum">
            {title.releaseInfo}
          </span>
        )}
      </span>
    </div>
  );
}

// The card, or the episode's play button, inside a trigger.
function focusTarget(trigger: HTMLElement | null): HTMLElement | boolean {
  return (
    trigger?.querySelector<HTMLElement>("[data-row-item], [data-episode-index], button") ?? true
  );
}

// The keyboard's way to a context menu: the context-menu key, and Shift+F10.
// Browsers raise a `contextmenu` event for these, but at no place in
// particular and not at all for Shift+F10 on a Mac, so this raises one at
// the element's centre, which the menu opens at. Returns whether it did.
export function openOnContextKey(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return false;
  event.preventDefault();
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );
  return true;
}

// Progress that shows in Continue Watching: begun and not at Nuvio's 90 %.
const started = (entry: Progress) =>
  entry.position > 0 && !(entry.duration > 0 && entry.position >= entry.duration * 0.9);

function TitleMenuItems({
  title,
  queue,
  confirm,
}: {
  title: MenuTitle;
  queue: DownloadQueue;
  confirm: (run: () => void) => void;
}) {
  const profile = useQuery(currentProfileQuery).data;
  return profile ? (
    <ProfileItems profile={profile} title={title} queue={queue} confirm={confirm} />
  ) : null;
}

function ProfileItems({
  profile,
  title,
  queue,
  confirm,
}: {
  profile: Profile;
  title: MenuTitle;
  queue: DownloadQueue;
  confirm: (run: () => void) => void;
}) {
  const client = useQueryClient();
  const play = usePlay();
  const open = useOpenTitle();
  const navigate = useNavigate();
  const edits = useTitleEdits(profile.id);
  const { addons, loading } = useLoadedAddons(profile.id);
  const details = useQuery({
    ...titleMetaQuery(addons, title.type, title.id),
    enabled: !loading,
    // A title seen before: its details from the cache at once.
    ...cachedTitleMeta(client, addons, title.type, title.id),
  });
  const marks = useQuery(titleWatchedQuery(profile.id, title.id)).data ?? [];
  const progress = useQuery(titleProgressQuery(profile.id, title.id)).data ?? [];
  const library = useQuery(libraryQuery(profile.id)).data;

  const loaded = details.data?.meta;
  // Until the details arrive, a film can be played and marked from what the
  // card knows; a series needs its episodes for both.
  const meta: Meta = loaded ?? { id: title.id, type: title.type, name: title.name };
  const series = isSeriesType(meta.type);
  const state = titleState(meta, marks, progress);
  const choice = playChoice(meta, state, progress);
  const saved = library?.some(
    (item) => item.contentId === meta.id && item.contentType === meta.type,
  );
  const watched = series ? state.seriesWatched : state.watched();
  const markable = !series || mainEpisodes(episodesOf(meta)).length > 0;
  const inProgress = progress.filter(started);
  const imdb = imdbIdOf(title, loaded);
  // Downloading (#85): a film itself, or a series' next-up episode. The
  // details name the download and say which addon served them.
  const downloads = useTitleDownloadsWith(profile.id, queue);
  const { video: downloadVideo, canDownload } = videoToDownload(
    meta,
    choice?.target.videoId,
    series,
  );
  const download = downloadState(
    downloads,
    meta,
    details.data?.addonUrl ?? "",
    downloadVideo,
  );

  const toggleWatched = () =>
    edits.setWatched.mutate({
      meta,
      watched: !watched,
      items: series
        ? [titleMark(meta), ...episodeMarks(meta, mainEpisodes(episodesOf(meta)))]
        : [titleMark(meta)],
    });

  const toggleLibrary = () => {
    if (saved) {
      edits.removeFromLibrary.mutate({
        contentId: meta.id,
        contentType: meta.type,
        name: meta.name,
      });
    } else if (details.data) {
      edits.saveToLibrary.mutate(libraryItem(details.data.meta, details.data.addonUrl));
    }
  };

  const chooseStream = () => {
    if (!choice) return;
    const { target } = choice;
    void navigate({
      to: streamsPath,
      params: { type: target.type, id: target.id },
      search: streamsSearch({ video: target.videoId, at: target.resumeAt }),
      state: (previous) => ({ ...previous, play: target }),
    });
  };

  const copyImdb = () => {
    if (!imdb) return;
    navigator.clipboard.writeText(imdbUrl(imdb)).then(
      () => toastManager.add({ type: "success", title: "Copied the IMDb link" }),
      () => toastManager.add({ type: "error", title: "Couldn’t copy the link" }),
    );
  };

  return (
    <>
      <ResponsiveMenuGroup>
        <ResponsiveMenuItem
          onClick={() =>
            play(choice?.target ?? { type: title.type, id: title.id, title: title.name })
          }
        >
          {choice?.resume ? (
            <RotateCcw aria-hidden />
          ) : (
            <Play aria-hidden className="fill-current" />
          )}
          {choice?.label ?? "Play"}
        </ResponsiveMenuItem>
        <ResponsiveMenuItem disabled={!choice} onClick={chooseStream}>
          <ListVideo aria-hidden />
          Choose a stream…
        </ResponsiveMenuItem>
        {canDownload && (
          <CardDownloadItems
            download={download}
            downloads={downloads}
            label={series ? "Download next episode" : "Download"}
            ready={details.data !== undefined}
          />
        )}
        <ResponsiveMenuItem onClick={() => open(title)}>
          <ArrowUpRight aria-hidden />
          Go to title
        </ResponsiveMenuItem>
      </ResponsiveMenuGroup>
      <ResponsiveMenuSeparator />
      <ResponsiveMenuGroup>
        <ResponsiveMenuItem
          disabled={library === undefined || (!saved && !details.data)}
          onClick={toggleLibrary}
        >
          {saved ? <Trash2 aria-hidden /> : <Plus aria-hidden />}
          {saved ? "Remove from Library" : "Add to Library"}
        </ResponsiveMenuItem>
        <ResponsiveMenuItem disabled={!markable} onClick={toggleWatched}>
          {watched ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {watched ? "Mark unwatched" : "Mark watched"}
        </ResponsiveMenuItem>
        {inProgress.length > 0 && (
          <ResponsiveMenuItem
            onClick={() =>
              edits.removeFromContinueWatching.mutate({
                contentId: meta.id,
                name: meta.name,
                entries: inProgress,
              })
            }
          >
            <X aria-hidden />
            Remove from Continue Watching
          </ResponsiveMenuItem>
        )}
      </ResponsiveMenuGroup>
      {imdb && (
        <>
          <ResponsiveMenuSeparator />
          <ResponsiveMenuItem onClick={copyImdb}>
            <LinkIcon aria-hidden />
            Copy IMDb link
          </ResponsiveMenuItem>
        </>
      )}
      <TitleMenuExtras title={title} meta={loaded} profile={profile} confirm={confirm} />
    </>
  );
}

// A card's menu rows for a download (#85): the film, or the show's next-up
// episode, where it is, and the way back out. The queue is the card's, so the
// ranking goes on once the menu closes.
function CardDownloadItems({
  download,
  downloads,
  label,
  ready,
}: {
  download: DownloadState;
  downloads: TitleDownloads;
  // "Download", or "Download next episode" for a series' card.
  label: string;
  // The details answer which addon the title came from; Go needs it.
  ready: boolean;
}) {
  const rows = downloadRows(download, label);
  const record = download.download;
  return (
    <>
      {rows.start && (
        <ResponsiveMenuItem
          disabled={!ready || rows.start.disabled}
          onClick={() => pressDownload(download, downloads)}
        >
          <ArrowDown aria-hidden />
          {rows.start.label}
        </ResponsiveMenuItem>
      )}
      {rows.status && (
        <ResponsiveMenuItem disabled>
          <ArrowDownCircle aria-hidden />
          {rows.status}
        </ResponsiveMenuItem>
      )}
      {rows.resume && (
        <ResponsiveMenuItem onClick={() => pressDownload(download, downloads)}>
          <RotateCcw aria-hidden />
          Resume download
        </ResponsiveMenuItem>
      )}
      {rows.remove && record && (
        <ResponsiveMenuItem onClick={() => void downloads.actions.remove([record.id])}>
          <Trash2 aria-hidden />
          Remove download
        </ResponsiveMenuItem>
      )}
    </>
  );
}
