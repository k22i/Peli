import {
  Blocks,
  Info,
  Languages,
  ListChecks,
  Palette,
  Play,
  Radio,
  Shield,
  UserRound,
  type LucideIcon,
} from "lucide-react";

export type SettingsPane = { id: string; title: string; icon: LucideIcon };

// The panes, in the order the list shows them. `?section=` names one.
export const settingsPanes = [
  { id: "account", title: "Account", icon: UserRound },
  { id: "content", title: "Addons & content", icon: Blocks },
  { id: "playback", title: "Playback", icon: Play },
  { id: "languages", title: "Languages & subtitles", icon: Languages },
  { id: "streaming", title: "Streaming", icon: Radio },
  { id: "tracking", title: "Tracking", icon: ListChecks },
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "privacy", title: "Privacy", icon: Shield },
  { id: "about", title: "About", icon: Info },
] as const satisfies readonly SettingsPane[];

export type PaneId = (typeof settingsPanes)[number]["id"];

export const defaultPane: PaneId = "account";

// An unknown or missing `?section=` is the default pane.
export function paneFromSearch(search: Record<string, unknown>): { section?: PaneId } {
  const pane = settingsPanes.find((candidate) => candidate.id === search["section"]);
  return pane ? { section: pane.id } : {};
}

// The pane last open this run, for Ctrl/⌘+, to come back to. A variable, not
// storage: a new run starts at the default pane.
let lastPane: PaneId = defaultPane;

export const rememberPane = (pane: PaneId) => {
  lastPane = pane;
};
export const lastOpenPane = (): PaneId => lastPane;
