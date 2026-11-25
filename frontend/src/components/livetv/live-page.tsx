import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { RadioTower } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { BrowseFrame, Notice } from "@/components/browse/browse-page";
import { ChannelList } from "@/components/livetv/channel-list";
import { GuideGrid } from "@/components/livetv/guide-grid";
import { CompactLibraryFrame } from "@/components/library/compact-frame";
import { Chip, ChipRail } from "@/components/media/chip";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import {
  channelsIn,
  favouritesGroup,
  groupLabel,
  groupsOf,
  sourcesQuery,
  useFavourites,
  useLiveChannels,
  type LiveSearch,
} from "@/lib/livetv";
import { useCurrentProfile } from "@/lib/profile";
import { useCompactShell } from "@/lib/shell-mode";

// Live TV (ADR-0066): a profile's IPTV channels, by group, or the guide of
// what they show. The group chip is in the address (?group=), so Back from a
// channel returns to the same list; the filter field is not, since it is
// about finding a channel now rather than about where you are. A profile
// with no playlist is sent to Settings to add one, and kids profiles never
// see the page at all (Go refuses the sources as well).
export function LivePage() {
  const profile = useCurrentProfile();
  const profileId = profile.id ?? 0;
  const sources = useQuery(sourcesQuery(profileId));
  const { channels, loading } = useLiveChannels(profileId);
  const favourites = useFavourites(profileId);
  const search = useSearch({ from: "/live" });
  const navigate = useNavigate({ from: "/live" });
  const [filter, setFilter] = useState("");
  const group = search.group ?? "";
  const shown = useMemo(
    () => channelsIn(channels, group, favourites, filter),
    [channels, group, favourites, filter],
  );

  // Kids profiles never see Live TV (ADR-0066, decision 5). They have no
  // sources either, so the settings invitation below never applies to them.
  if (profile.kids) return <Navigate to="/" replace />;

  const field = <FilterField value={filter} onChange={setFilter} />;

  if (sources.data?.length === 0) {
    return (
      <LiveFrame field={field}>
        <Notice
          icon={RadioTower}
          title="No Live TV yet"
          description="Add an M3U playlist in Settings › Live TV."
          action={
            <Link to="/settings" search={{ section: "livetv" }} className={buttonVariants()}>
              Open Settings
            </Link>
          }
        />
      </LiveFrame>
    );
  }

  const chips = (
    <ChipRail
      railClassName="min-w-0 flex-1"
      aria-label="Group"
      value={[group || allChip]}
      onValueChange={(value: string[]) => {
        const [next] = value;
        if (!next) return;
        // Replaced, not pushed: Back leaves the page rather than undoing a
        // chip.
        void navigate({
          to: ".",
          search: (previous: LiveSearch): LiveSearch =>
            liveAddress({ view: previous.view ?? "", group: next === allChip ? "" : next }),
          replace: true,
        });
      }}
    >
      <Chip value={allChip}>All</Chip>
      {favourites.length > 0 && <Chip value={favouritesGroup}>Favourites</Chip>}
      {groupsOf(channels).map((value) => (
        <Chip key={value} value={value}>
          {groupLabel(value)}
        </Chip>
      ))}
    </ChipRail>
  );

  return (
    <LiveFrame chips={chips} field={field}>
      {loading ? (
        <div aria-hidden className="flex flex-col gap-3 px-page">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : shown.length === 0 && channels.length > 0 ? (
        <Notice title="No channels match" description="Try another group or filter." />
      ) : search.view === "guide" ? (
        <GuideGrid channels={shown} group={group} />
      ) : (
        <ChannelList channels={shown} group={group} profileId={profileId} favourites={favourites} />
      )}
    </LiveFrame>
  );
}

// The page's header: Browse's on a wide window (#116) and the compact one on
// an iPhone (#132). Both carry the title, the view switch and the group
// chips; the filter field sits beside the switch, or, compact, at the top of
// the page under the chips, where a thumb reaches it.
function LiveFrame({
  chips,
  field,
  children,
}: {
  chips?: ReactNode;
  field: ReactNode;
  children: ReactNode;
}) {
  const compact = useCompactShell();
  if (compact) {
    return (
      <CompactLibraryFrame title="Live TV" switcher={<ViewSwitch compact />} rail={chips}>
        <div className="px-page pb-3">{field}</div>
        {children}
      </CompactLibraryFrame>
    );
  }
  return (
    <BrowseFrame
      title="Live TV"
      filter={
        <>
          <ViewSwitch />
          {field}
        </>
      }
      rail={chips}
    >
      {children}
    </BrowseFrame>
  );
}

// Channels or Guide: coss Tabs as a segmented control on an ink tint, the
// pill a wrapper since a tier sets its own background, the tab list inside
// it bare with the raised knob as its indicator. The same as the Library's
// view switch (#118).
//
// `compact` (#132, iPhone): a full-width segmented control, equal segments,
// 36 pt tall with a 9 pt radius.
function ViewSwitch({ compact = false }: { compact?: boolean }) {
  const search = useSearch({ from: "/live" });
  const navigate = useNavigate({ from: "/live" });
  return (
    // Replaced, as the chips are; the default view stays out of the address.
    <Tabs
      value={search.view ?? "channels"}
      onValueChange={(next: string) =>
        void navigate({
          to: ".",
          search: (previous: LiveSearch): LiveSearch =>
            liveAddress({ view: next, group: previous.group ?? "" }),
          replace: true,
        })
      }
    >
      {compact ? (
        <TabsList
          aria-label="View"
          className="grid h-9 w-full grid-cols-2 gap-0 rounded-[9px] bg-foreground/7 p-0.5 text-muted-foreground *:data-[slot=tab-indicator]:rounded-[7px] *:data-[slot=tab-indicator]:bg-background *:data-[slot=tab-indicator]:shadow-card dark:*:data-[slot=tab-indicator]:bg-foreground/16 dark:*:data-[slot=tab-indicator]:shadow-none"
        >
          <TabsTab value="channels" className={segment}>
            Channels
          </TabsTab>
          <TabsTab value="guide" className={segment}>
            Guide
          </TabsTab>
        </TabsList>
      ) : (
        <span className="inline-flex rounded-full bg-foreground/7 p-1">
          <TabsList
            aria-label="View"
            className="gap-x-1 rounded-full bg-transparent p-0 text-muted-foreground *:data-[slot=tab-indicator]:rounded-full *:data-[slot=tab-indicator]:bg-background *:data-[slot=tab-indicator]:shadow-card dark:*:data-[slot=tab-indicator]:bg-foreground/16 dark:*:data-[slot=tab-indicator]:shadow-none"
          >
            <TabsTab value="channels" className="rounded-full px-4">
              Channels
            </TabsTab>
            <TabsTab value="guide" className="rounded-full px-4">
              Guide
            </TabsTab>
          </TabsList>
        </span>
      )}
    </Tabs>
  );
}

// A compact switch's segment: the whole half, 32 pt inside the 2 pt padding.
const segment = "h-8 min-w-0 rounded-[7px] px-1 text-[0.8125rem] font-[590] sm:h-8";

// The filter over the list: a channel's name, or its number.
function FilterField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Input
      type="search"
      aria-label="Filter channels"
      placeholder="Filter channels"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-56 max-md:w-full"
    />
  );
}

// The All chip's value. It is a value of its own because "" is a value too
// (no group), and Base UI gives a Toggle with value="" a generated id.
const allChip = ":all";

// A /live search object with `view` and `group`, leaving the defaults out of
// the address: no view is the channel list, no group is every channel. Its
// fields are set one at a time, since exactOptionalPropertyTypes refuses an
// explicit `undefined` for `view?: "guide"` or `group?: string`.
function liveAddress(next: { view: string; group: string }): LiveSearch {
  const search: LiveSearch = {};
  if (next.view === "guide") search.view = "guide";
  if (next.group) search.group = next.group;
  return search;
}
