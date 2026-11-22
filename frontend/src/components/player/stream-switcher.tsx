import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Download } from "lucide-react";

import type { Watching } from "@bindings/playback";
import { Connection } from "@bindings/syncer";
import { Spinner } from "@/components/ui/spinner";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { StreamList } from "@/components/streams/stream-list";
import { useStreamChoices } from "@/components/streams/stream-choices";
import { StreamsSummary, usePlayKey } from "@/components/streams/streams-page";
import { filteredListProps } from "@/components/streams/stream-toolbar";
import type { Stream } from "@/lib/addon-protocol";
import { formatBytes, playableQuery, type Playable } from "@/lib/downloads";
import { cn } from "@/lib/utils";
import { useConnection } from "@/lib/sync";
import type { Candidate } from "@/lib/ranking";
import { attempts, sameStream, type ResolveOptions } from "@/lib/resolve";

// Asks a stream's source (an addon, a plugin) again for a fresh link.
export type Refresh = ResolveOptions["refresh"];

// The stream switcher (#68, F24): the picker's ranked streams for the film
// or episode playing, in a panel over the video, with the one playing
// marked. Picking one hands it to the player, which plays it from where
// this one is. The addons are asked while it's open (usually answered from
// the picker's cache), and closing it aborts what's still out, as leaving
// the picker does. A finished download of the video (ADR-0064) leads the
// list as "Downloaded"; offline it is all the list has.
export function StreamSwitcher({
  open,
  onOpenChange,
  watching,
  title,
  playing,
  playingDownload,
  status,
  onPick,
  onPickDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watching: Watching;
  // The heading's title, for ranking until the details come.
  title: string;
  // The addon's stream playing now.
  playing: Stream | undefined;
  // Whether it's the downloaded copy playing.
  playingDownload: boolean;
  // The stream being opened, or why the last pick couldn't be.
  status: { text: string; failed?: string } | undefined;
  onPick: (candidate: Candidate, names: ReadonlyMap<string, string>, refresh: Refresh) => void;
  onPickDownload: (playable: Playable) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        side="right"
        className="dark max-w-lg text-foreground [--spacing-page:--spacing(3)]"
      >
        <SheetHeader className="px-6 pb-3">
          <SheetTitle>Streams</SheetTitle>
          <SheetDescription>Another stream plays from where this one is.</SheetDescription>
          <div aria-live="polite">
            {status &&
              (status.failed ? (
                <div role="alert" className="flex items-start gap-2 text-body">
                  <AlertCircle
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
                  />
                  <p>
                    {status.text && <span className="font-medium">{status.text} </span>}
                    <span className="text-muted-foreground">{status.failed}</span>
                  </p>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-body">
                  <Spinner className="size-3.5" />
                  {status.text}
                </p>
              ))}
          </div>
        </SheetHeader>
        <Choices
          watching={watching}
          title={title}
          playing={playing}
          playingDownload={playingDownload}
          onPick={onPick}
          onPickDownload={onPickDownload}
        />
      </SheetPopup>
    </Sheet>
  );
}

// Mounted only while the panel is open: the downloaded copy, if there is
// one, then the addons' streams, which need a connection.
function Choices({
  watching,
  title,
  playing,
  playingDownload,
  onPick,
  onPickDownload,
}: {
  watching: Watching;
  title: string;
  playing: Stream | undefined;
  playingDownload: boolean;
  onPick: (candidate: Candidate, names: ReadonlyMap<string, string>, refresh: Refresh) => void;
  onPickDownload: (playable: Playable) => void;
}) {
  const offline = useConnection() === Connection.Offline;
  const local = useQuery(playableQuery(watching.profileId, watching.videoId)).data;
  return (
    <>
      {local && (
        <DownloadedCopy playable={local} playing={playingDownload} onPick={onPickDownload} />
      )}
      {offline ? (
        <p className="px-6 py-4 text-body text-muted-foreground">
          Other streams need a connection.
        </p>
      ) : (
        <Streams watching={watching} title={title} playing={playing} onPick={onPick} />
      )}
    </>
  );
}

// The local copy, as a row ahead of the list.
function DownloadedCopy({
  playable,
  playing,
  onPick,
}: {
  playable: Playable;
  playing: boolean;
  onPick: (playable: Playable) => void;
}) {
  const { download } = playable;
  const detail = [download.resolution, download.streamName, formatBytes(download.total)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="px-6 pb-3">
      <button
        type="button"
        onClick={() => onPick(playable)}
        aria-current={playing ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-2xl border border-border bg-card/60 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          playing && "border-foreground/40",
        )}
      >
        <Download aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">Downloaded</span>
          {detail && <span className="truncate text-small text-muted-foreground">{detail}</span>}
        </span>
        {playing && <span className="text-small text-muted-foreground">Playing</span>}
      </button>
    </div>
  );
}

// The addons' ranked streams.
function Streams({
  watching,
  title,
  playing,
  onPick,
}: {
  watching: Watching;
  title: string;
  playing: Stream | undefined;
  onPick: (candidate: Candidate, names: ReadonlyMap<string, string>, refresh: Refresh) => void;
}) {
  const {
    loading,
    sources,
    names,
    view,
    ranked,
    pin,
    rows,
    toggleGroup,
    refresh,
    usual,
    filtering,
    sourceFilter,
  } = useStreamChoices(
    watching.profileId,
    watching.contentType,
    watching.contentId,
    watching.videoId,
    title || (watching.title ?? ""),
  );
  const pick = (candidate: Candidate) => {
    pin();
    onPick(candidate, names, refresh);
  };
  usePlayKey(view.top, pick);
  const isPlaying = (candidate: Candidate) =>
    playing !== undefined && attempts(candidate).some(({ stream }) => sameStream(stream, playing));

  if (sources.length === 0) {
    return (
      <div className="flex justify-center px-6 py-12 text-center text-body text-muted-foreground">
        {loading ? (
          <Spinner className="size-6" />
        ) : (
          "None of your enabled addons serves streams for this."
        )}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-6">
      <StreamsSummary
        sources={sources}
        loading={loading}
        total={ranked.total}
        shown={view.total}
        filter={sourceFilter}
      />
      <StreamList
        rows={rows}
        names={names}
        onNavigate={pin}
        onPick={pick}
        onToggleGroup={toggleGroup}
        playing={isPlaying}
        usual={usual}
        panel
        {...filteredListProps(filtering, view, { stacked: true })}
      />
    </div>
  );
}
