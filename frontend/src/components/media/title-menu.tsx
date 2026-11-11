import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
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
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import type { Profile, Progress } from "@bindings/store";
import { TitleMenuExtras } from "@/components/media/title-menu-extras";
import {
  ContextMenu,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { toastManager } from "@/components/ui/toast";
import type { Meta } from "@/lib/addon-protocol";
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
// watched, the stream picker, its IMDb link. `children` is the card; the
// context-menu key and Shift+F10 open it too (see `openOnContextKey`), and
// closing it hands the focus back to the card. Groups from other features go
// in TitleMenuExtras. Everything but the card's own preview is read when the
// menu opens, so a screen of cards costs nothing.
export function TitleMenu({ title, children }: { title: MenuTitle; children: ReactNode }) {
  const trigger = useRef<HTMLDivElement>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger ref={trigger} className="contents">
        {children}
      </ContextMenuTrigger>
      <ContextMenuPopup
        className="material-pop w-60"
        // Not the trigger, which is a layout-less wrapper: the card in it.
        finalFocus={() => focusTarget(trigger.current)}
      >
        <TitleMenuItems title={title} />
      </ContextMenuPopup>
    </ContextMenu>
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

function TitleMenuItems({ title }: { title: MenuTitle }) {
  const profile = useQuery(currentProfileQuery).data;
  return profile ? <ProfileItems profile={profile} title={title} /> : null;
}

function ProfileItems({ profile, title }: { profile: Profile; title: MenuTitle }) {
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
      <ContextMenuGroup>
        <ContextMenuItem
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
        </ContextMenuItem>
        <ContextMenuItem disabled={!choice} onClick={chooseStream}>
          <ListVideo aria-hidden />
          Choose a stream…
        </ContextMenuItem>
        <ContextMenuItem onClick={() => open(title)}>
          <ArrowUpRight aria-hidden />
          Go to title
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem
          disabled={library === undefined || (!saved && !details.data)}
          onClick={toggleLibrary}
        >
          {saved ? <Trash2 aria-hidden /> : <Plus aria-hidden />}
          {saved ? "Remove from Library" : "Add to Library"}
        </ContextMenuItem>
        <ContextMenuItem disabled={!markable} onClick={toggleWatched}>
          {watched ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {watched ? "Mark unwatched" : "Mark watched"}
        </ContextMenuItem>
        {inProgress.length > 0 && (
          <ContextMenuItem
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
          </ContextMenuItem>
        )}
      </ContextMenuGroup>
      {imdb && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={copyImdb}>
            <LinkIcon aria-hidden />
            Copy IMDb link
          </ContextMenuItem>
        </>
      )}
      <TitleMenuExtras title={title} meta={loaded} profile={profile} />
    </>
  );
}
