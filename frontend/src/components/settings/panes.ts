import {
  Blocks,
  Info,
  Languages,
  ListChecks,
  Palette,
  Play,
  Puzzle,
  Radio,
  Shield,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { feature } from "@/lib/features";

export type SettingsPane = { id: string; title: string; icon: LucideIcon };

// The panes, in the order the list shows them. `?section=` names one.
const allPanes = [
  { id: "account", title: "Account", icon: UserRound },
  { id: "content", title: "Addons & content", icon: Blocks },
  { id: "playback", title: "Playback", icon: Play },
  { id: "languages", title: "Languages & subtitles", icon: Languages },
  { id: "streaming", title: "Streaming", icon: Radio },
  { id: "plugins", title: "Plugins", icon: Puzzle },
  { id: "tracking", title: "Tracking", icon: ListChecks },
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "privacy", title: "Privacy", icon: Shield },
  { id: "about", title: "About", icon: Info },
] as const satisfies readonly SettingsPane[];

export type PaneId = (typeof allPanes)[number]["id"];

// The panes this build shows: the iOS app has no plugins (ADR-0055). A
// function, not a constant, since the platform is read when asked.
export function visiblePanes(): readonly (typeof allPanes)[number][] {
  return allPanes.filter((pane) => pane.id !== "plugins" || feature("plugins"));
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
