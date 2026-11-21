import {
  Blocks,
  Download,
  Info,
  Languages,
  ListChecks,
  Play,
  Puzzle,
  Radio,
  Shield,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { feature } from "@/lib/features";

// `tone` is the colour of the icon's rounded square in the phone's pane list
// (#137), as in the iOS Settings app: a background class, with a white glyph.
export type SettingsPane = { id: string; title: string; icon: LucideIcon; tone: string };

// The panes, in the order the list shows them. `?section=` names one.
const allPanes = [
  { id: "account", title: "Account", icon: UserRound, tone: "bg-[#0a84ff]" },
  { id: "content", title: "Addons & content", icon: Blocks, tone: "bg-[#af52de]" },
  { id: "playback", title: "Playback", icon: Play, tone: "bg-[#ff6b35]" },
  { id: "languages", title: "Languages & subtitles", icon: Languages, tone: "bg-[#2e9e5b]" },
  { id: "streaming", title: "Streaming", icon: Radio, tone: "bg-[#0a8fa8]" },
  // Downloads for offline viewing (#85, ADR-0064), right after how streams are
  // picked: what Peli keeps on this device and for how long.
  { id: "downloads", title: "Downloads", icon: Download, tone: "bg-[#5856d6]" },
  { id: "plugins", title: "Plugins", icon: Puzzle, tone: "bg-[#6e6e73]" },
  { id: "tracking", title: "Tracking", icon: ListChecks, tone: "bg-[#d4337a]" },
  { id: "privacy", title: "Privacy", icon: Shield, tone: "bg-[#3a8a3a]" },
  { id: "about", title: "About", icon: Info, tone: "bg-[#6e6e73]" },
] as const satisfies readonly SettingsPane[];

export type PaneId = (typeof allPanes)[number]["id"];

// The panes this build shows: the iOS app has no plugins (ADR-0055). A
// function, not a constant, since the platform is read when asked.
export function visiblePanes(): readonly (typeof allPanes)[number][] {
  return allPanes.filter((pane) => pane.id !== "plugins" || feature("plugins"));
}

// The panes in the phone's list, a group to a card (#137): you, what Peli
// plays and how, what it connects to, then privacy and what it is.
const paneGroups: readonly (readonly PaneId[])[] = [
  ["account"],
  ["content", "playback", "languages", "streaming", "downloads", "plugins"],
  ["tracking"],
  ["privacy", "about"],
];

// The groups with only the panes this build shows; none left empty.
export function visiblePaneGroups(): (typeof allPanes)[number][][] {
  const panes = visiblePanes();
  return paneGroups
    .map((ids) => panes.filter((pane) => ids.includes(pane.id)))
    .filter((group) => group.length > 0);
}

export const defaultPane: PaneId = "account";

// An unknown or missing `?section=` is the default pane.
export function paneFromSearch(search: Record<string, unknown>): { section?: PaneId } {
  const pane = visiblePanes().find((candidate) => candidate.id === search["section"]);
  return pane ? { section: pane.id } : {};
}

// The pane last open this run, for Ctrl/⌘+, to come back to. A variable, not
// storage: a new run starts at the default pane.
let lastPane: PaneId = defaultPane;

export const rememberPane = (pane: PaneId) => {
  lastPane = pane;
};
export const lastOpenPane = (): PaneId => lastPane;
