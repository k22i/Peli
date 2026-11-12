import { AlertCircle } from "lucide-react";

import type { Watching } from "@bindings/playback";
import { Spinner } from "@/components/ui/spinner";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { StreamList } from "@/components/streams/stream-list";
import { StreamsSummary, usePlayKey, useStreamChoices } from "@/components/streams/streams-page";
import type { Stream } from "@/lib/addon-protocol";
import type { Candidate } from "@/lib/ranking";
import { attempts, sameStream, type ResolveOptions } from "@/lib/resolve";

// Asks a stream's source (an addon, a plugin) again for a fresh link.
export type Refresh = ResolveOptions["refresh"];

// The stream switcher (#68, F24): the picker's ranked streams for the film
// or episode playing, in a panel over the video, with the one playing
// marked. Picking one hands it to the player, which plays it from where
// this one is. The addons are asked while it's open (usually answered from
// the picker's cache), and closing it aborts what's still out, as leaving
// the picker does.
export function StreamSwitcher({
  open,
  onOpenChange,
  watching,
  title,
  playing,
  status,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watching: Watching;
  // The heading's title, for ranking until the details come.
  title: string;
  // The addon's stream playing now.
  playing: Stream | undefined;
  // The stream being opened, or why the last pick couldn't be.
  status: { text: string; failed?: string } | undefined;
  onPick: (candidate: Candidate, names: ReadonlyMap<string, string>, refresh: Refresh) => void;
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
        <Choices watching={watching} title={title} playing={playing} onPick={onPick} />
      </SheetPopup>
    </Sheet>
  );
}

// Mounted only while the panel is open.
function Choices({
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
  const { loading, sources, names, view, pin, rows, toggleGroup, refresh, usual } =
    useStreamChoices(
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
      <StreamsSummary sources={sources} loading={loading} total={view.total} />
      <StreamList
        rows={rows}
        names={names}
        onNavigate={pin}
        onPick={pick}
        onToggleGroup={toggleGroup}
        playing={isPlaying}
        usual={usual}
      />
    </div>
  );
}
