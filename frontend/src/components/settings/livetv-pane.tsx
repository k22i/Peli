import { useQuery } from "@tanstack/react-query";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AddSourceDialog,
  RemoveSourceDialog,
  RenameSourceDialog,
} from "@/components/settings/livetv-dialogs";
import {
  SettingRow,
  SettingsGroup,
  SettingsPaneView,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { sourcesQuery, useLiveSources, useSourceActions, type Source } from "@/lib/livetv";
import { useCurrentProfile } from "@/lib/profile";

// Settings › Live TV (ADR-0066): the profile's IPTV sources, each an M3U
// playlist with the XMLTV guide it came with or was given. A row says what
// the source's last refresh found and when, and the buttons beside it refresh
// it now, rename it or remove it; the last row adds another.
//
// A source's links are the keychain's, since they can carry a user name and
// password, so this pane never shows or asks for them again: a source is its
// name and what it loaded. Go fetches and parses both, and keeps the answer
// on disk.
//
// Kids profiles have none: Go refuses every Live TV call with `kids_profile`,
// and the nav entry is gone with the sources (lib/livetv).

const lead =
  "Channels from an IPTV playlist (M3U) and a programme guide (XMLTV). Links stay in the keychain, as they can hold a password.";

const kidsLead = "Kids profiles don’t have Live TV.";

export function LiveTVPane({
  title,
  profileId,
}: {
  title: string;
  profileId?: number | undefined;
}) {
  const profile = useCurrentProfile();
  return (
    <SettingsPaneView title={title} lead={profile.kids ? kidsLead : lead}>
      {profile.kids ? null : <Sources profileId={profileId ?? 0} />}
    </SettingsPaneView>
  );
}

function Sources({ profileId }: { profileId: number }) {
  const sources = useLiveSources(profileId);
  // useLiveSources answers the list alone, so the pane asks the same query
  // whether it has arrived yet; a row cannot say "Not updated yet" and
  // "Loading" at once.
  const pending = useQuery(sourcesQuery(profileId)).isPending;
  const { refresh } = useSourceActions(profileId);
  const [now, setNow] = useState(Date.now);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Source>();
  const [removing, setRemoving] = useState<Source>();

  // Every row says how long ago its playlist loaded, so the pane reads the
  // clock again each minute; nothing else here moves on its own.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <SettingsGroup
        title="Sources"
        footer="Playlists update every 12 hours, guides every 6. Refresh updates one now."
      >
        {pending ? (
          <Skeleton className="h-14 rounded-2xl" />
        ) : (
          <>
            {sources.map((source) => (
              <SettingRow
                key={source.id}
                id={`livetv-${source.id}`}
                label={source.name}
                description={sourceStatus(source, now)}
              >
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Refresh ${source.name}`}
                    disabled={source.refreshing}
                    onClick={() => refresh.mutate(source.id)}
                  >
                    <RefreshCw className={source.refreshing ? "animate-spin" : undefined} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Rename ${source.name}`}
                    onClick={() => setRenaming(source)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${source.name}`}
                    onClick={() => setRemoving(source)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </SettingRow>
            ))}
            <SettingRow
              id="livetv-add"
              label="Add a source"
              description="An M3U or M3U8 link, a file:// link or a file on this device."
            >
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                Add…
              </Button>
            </SettingRow>
          </>
        )}
      </SettingsGroup>
      <AddSourceDialog open={adding} onOpenChange={setAdding} profileId={profileId} />
      <RenameSourceDialog
        source={renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(undefined);
        }}
        profileId={profileId}
      />
      <RemoveSourceDialog
        source={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        profileId={profileId}
      />
    </>
  );
}

// What a source's row says it has: the first of the states that matters, then
// the counts and how old the playlist is. `now` moves on by the minute.
export function sourceStatus(source: Source, now: number): string {
  if (source.refreshing) return "Updating…";
  if (source.playlistError) return playlistErrorText(source.playlistError);
  if (source.playlistAt === 0) return "Not updated yet";
  const guide = !source.hasGuide
    ? "No guide"
    : source.guideError
      ? "Guide didn’t load"
      : `Guide for ${source.guideChannels.toLocaleString()}`;
  return [channelCount(source.channels), guide, updatedLabel(source.playlistAt, now)].join(" · ");
}

const channelCount = (channels: number): string =>
  channels === 1 ? "1 channel" : `${channels.toLocaleString()} channels`;

// Go's playlist error code as a sentence. It never names the link.
function playlistErrorText(code: string): string {
  switch (code) {
    case "unreachable":
      return "Playlist didn’t load: the link didn’t answer.";
    case "timeout":
      return "Playlist didn’t load: it took too long.";
    case "too_large":
      return "Playlist didn’t load: it’s too large.";
    case "not_playlist":
      return "Playlist didn’t load: there are no channels in it.";
    default:
      return "Playlist didn’t load.";
  }
}

// When the playlist last loaded, as a row says it ("Updated 5 minutes ago").
// The formatter is the platform's, so each language words it its own way.
export function updatedLabel(at: number, now: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  // A clock that moved back, or a record from the future, reads as just now
  // rather than as a negative age.
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "Updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${rtf.format(-minutes, "minute")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${rtf.format(-hours, "hour")}`;
  return `Updated ${rtf.format(-Math.floor(hours / 24), "day")}`;
}
