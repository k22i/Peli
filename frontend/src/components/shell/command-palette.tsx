import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Blocks,
  CalendarDays,
  Clock,
  PartyPopper,
  Search as SearchIcon,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { visiblePanes } from "@/components/settings/panes";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { searchQuery } from "@/lib/addon-protocol";
import { useLeaveOutAnime } from "@/lib/anime";
import { useAnimePosterAddon, useFollowAnime } from "@/lib/anime-titles";
import { isAnimeCatalog } from "@/lib/browse";
import { useUnlockedProfiles } from "@/lib/account";
import { useBrowsableAddons } from "@/lib/home";
import { lastWatchedQuery, libraryPreview, libraryQuery } from "@/lib/library";
import { useLiveTVAvailable } from "@/lib/livetv";
import {
  commandMatches,
  isPaletteShortcut,
  paletteTerm,
  recentTitles,
  titlesPerGroup,
} from "@/lib/palette";
import { currentPlatform } from "@/lib/platform";
import { currentProfileQuery } from "@/lib/profile";
import { searchCatalogs, searchDebounceMs, searchGroups } from "@/lib/search";
import { useOpenTitle, type TitlePreview } from "@/lib/title";
import { liveSection, sections } from "@/sections";
import type { Profile } from "@bindings/store";

// One row of the palette: what it says, and what Enter does.
type Entry = {
  id: string;
  label: string;
  // Words that find it besides its label.
  keywords?: string;
  hint?: string | undefined;
  icon?: LucideIcon;
  shortcut?: string;
  run: () => void;
};
type EntryGroup = { value: string; items: Entry[] };

// Ctrl/⌘+K: search titles and jump anywhere from the keyboard. Mounted by the
// app shell for the screens that have chrome, so it isn't there on the
// player (which has none) or before a profile is picked; a PIN-locked
// profile gets it once unlocked. `onNavigate` is the shell's "move focus to
// the new page" hook, so a command moves you the way ⌘1–6 does, while Esc
// puts focus back where it was.
export function CommandPalette({ onNavigate }: { onNavigate: () => void }) {
  const profile = useQuery(currentProfileQuery).data;
  const unlocked = useUnlockedProfiles();
  const [open, setOpen] = useState(false);
  // Esc and a click outside restore focus; running a command doesn't, since
  // the new page takes it.
  const restoreFocus = useRef(true);
  // What had focus when it opened, since there's no trigger to go back to.
  const opener = useRef<HTMLElement | null>(null);
  const locked = profile?.pinEnabled === true && !unlocked.includes(profile.id);
  const available = profile !== undefined && !locked;

  useEffect(() => {
    if (!available) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      restoreFocus.current = true;
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen((was) => !was);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [available]);

  if (!available) return null;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup
        aria-label="Command palette"
        finalFocus={() => (restoreFocus.current ? opener.current : false)}
        className="max-w-xl"
      >
        <PaletteBody
          profile={profile}
          done={() => {
            restoreFocus.current = false;
            onNavigate();
            setOpen(false);
          }}
        />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function PaletteBody({ profile, done }: { profile: Profile; done: () => void }) {
  const navigate = useNavigate();
  const openTitle = useOpenTitle();
  const [text, setText] = useState("");
  const [term, setTerm] = useState<string | undefined>();

  // Typing pauses before a search goes out, as on the Search page.
  useEffect(() => {
    const next = paletteTerm(text);
    if (next === term) return undefined;
    const timer = setTimeout(() => setTerm(next), next === undefined ? 0 : searchDebounceMs);
    return () => clearTimeout(timer);
  }, [text, term]);

  const { addons, shown, loading } = useBrowsableAddons(profile.id);
  const leaveOutAnime = useLeaveOutAnime(profile.id);
  // Not until a kids profile's allowed catalogs are known: the rest are never
  // asked, as on the Search page.
  const catalogs = loading ? [] : searchCatalogs(addons, shown);
  const queries = useQueries({
    queries:
      term === undefined
        ? []
        : catalogs.map(({ addon, catalog }) =>
            searchQuery(addon.url, catalog.type, catalog.id, term),
          ),
  });
  // AniList's results as the poster addon's titles (lib/anime-titles.ts).
  const answers = catalogs.map((source, i) => ({ source, metas: queries[i]?.data?.metas }));
  const { follow } = useFollowAnime(
    useAnimePosterAddon(profile.id),
    answers.flatMap(({ source, metas }) => (isAnimeCatalog(source) ? (metas ?? []) : [])),
  );
  const library = useQuery(libraryQuery(profile.id)).data;
  const lastWatched = useQuery(lastWatchedQuery(profile.id)).data;
  // Live TV (ADR-0066) is a page only while the profile has a source.
  const live = useLiveTVAvailable();

  const mac = currentPlatform() === "mac";
  const go = (run: () => void) => () => {
    done();
    run();
  };
  const open = (meta: TitlePreview) => go(() => openTitle(meta));

  const pages: Entry[] = [
    ...sections
      .map((section, index) => ({ section, number: index + 1 }))
      .map(({ section, number }) => ({
        id: `go:${section.to}`,
        label: section.label,
        icon: section.icon,
        shortcut: `${mac ? "⌘" : "Ctrl+"}${number}`,
        run: go(() => void navigate({ to: section.to })),
      })),
    // Live TV is no ⌘ number: it joins the list after the six.
    ...(live
      ? [
          {
            id: "go:/live",
            label: "Live TV",
            keywords: "iptv channels guide tv",
            icon: liveSection.icon,
            run: go(() => void navigate({ to: "/live" })),
          },
        ]
      : []),
    {
      id: "go:upcoming",
      label: "Upcoming",
      keywords: "calendar episodes",
      icon: CalendarDays,
      run: go(() => void navigate({ to: "/library", search: { view: "upcoming" } })),
    },
    // A kids profile needs its parent PIN for addons, which the profile menu
    // asks for, so the palette doesn't offer them there.
    // Watch parties (ADR-0051): never for a kids profile.
    ...(profile.kids
      ? []
      : [
          {
            id: "go:party",
            label: "Watch party",
            keywords: "join together friends code invite host",
            icon: PartyPopper,
            run: go(() => void navigate({ to: "/party" })),
          },
        ]),
    ...(profile.kids
      ? []
      : [
          {
            id: "go:addons",
            label: "Addons",
            keywords: "catalogs plugins install",
            icon: Blocks,
            run: go(() => void navigate({ to: "/addons" })),
          },
        ]),
    ...visiblePanes().map((pane) => ({
      id: `settings:${pane.id}`,
      label: `Settings: ${pane.title}`,
      icon: pane.icon,
      run: go(() => void navigate({ to: "/settings", search: { section: pane.id } })),
    })),
    {
      id: "profile:switch",
      label: "Switch profile",
      keywords: "who is watching account",
      icon: Users,
      // The picker leaves a kids profile only with its parent PIN, and asks
      // a locked one for its PIN.
      run: go(() => void navigate({ to: "/profiles" })),
    },
  ];

  const groups: EntryGroup[] = [];
  const query = text.trim();
  if (query === "") {
    const recent = recentTitles(library ?? [], lastWatched ?? {}).map((item): Entry => ({
      id: `recent:${item.contentId}`,
      label: item.name || item.contentId,
      hint: item.releaseInfo,
      icon: Clock,
      run: open(libraryPreview(item)),
    }));
    if (recent.length > 0) groups.push({ value: "Recent", items: recent });
    groups.push({ value: "Go to", items: pages });
  } else {
    const matching = pages.filter((entry) =>
      commandMatches(entry.label, entry.keywords ?? "", query),
    );
    const found = searchGroups(answers, leaveOutAnime, follow).map((group): EntryGroup => ({
      value: group.title,
      items: group.metas.slice(0, titlesPerGroup).map((meta) => ({
        id: `title:${meta.id}`,
        label: meta.name,
        hint: meta.releaseInfo,
        icon: SearchIcon,
        run: open(meta),
      })),
    }));
    groups.push(...found);
    if (matching.length > 0) groups.push({ value: "Go to", items: matching });
  }

  const searching =
    term !== undefined && (loading || queries.some((candidate) => candidate.isPending));
  const waiting = query !== "" && paletteTerm(text) !== term;

  return (
    <Command
      items={groups}
      filter={null}
      value={text}
      onValueChange={(value) => setText(value)}
      itemToStringValue={(entry) =>
        typeof entry === "object" && entry !== null && "label" in entry ? String(entry.label) : ""
      }
    >
      <CommandInput aria-label="Search titles or jump to" placeholder="Search titles or jump to…" />
      <CommandPanel>
        <CommandEmpty>{searching || waiting ? "Searching…" : "Nothing found."}</CommandEmpty>
        <CommandList>
          {(group: EntryGroup) => (
            <CommandGroup key={group.value} items={group.items}>
              <CommandGroupLabel>{group.value}</CommandGroupLabel>
              <CommandCollection>
                {(entry: Entry) => (
                  <CommandItem key={entry.id} value={entry} onClick={entry.run} className="gap-3">
                    {entry.icon && (
                      <entry.icon aria-hidden className="size-4 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.hint && (
                      <span className="text-muted-foreground text-xs">{entry.hint}</span>
                    )}
                    {entry.shortcut && (
                      <CommandShortcut aria-hidden>{entry.shortcut}</CommandShortcut>
                    )}
                  </CommandItem>
                )}
              </CommandCollection>
            </CommandGroup>
          )}
        </CommandList>
      </CommandPanel>
      <CommandFooter>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            Move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            Open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            Close
          </span>
        </span>
        {searching && <Spinner aria-label="Searching" className="size-4" />}
      </CommandFooter>
    </Command>
  );
}
