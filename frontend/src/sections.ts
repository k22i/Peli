import type { LinkProps } from "@tanstack/react-router";
import {
  Clapperboard,
  House,
  Library,
  type LucideIcon,
  RadioTower,
  Search,
  Sparkles,
  Tv,
} from "lucide-react";

export type Section = {
  label: string;
  to: NonNullable<LinkProps["to"]>;
  icon: LucideIcon;
};

// The top-level navigation, in order: Ctrl/⌘+1–6 jump to them. Capped at 6
// items (epic #9); any new item needs a written case. Settings, the profile
// switcher and addons live in the profile menu instead.
export const sections = [
  { label: "Home", to: "/", icon: House },
  { label: "Movies", to: "/movies", icon: Clapperboard },
  { label: "Shows", to: "/shows", icon: Tv },
  { label: "Anime", to: "/anime", icon: Sparkles },
  { label: "Search", to: "/search", icon: Search },
  { label: "Library", to: "/library", icon: Library },
] as const satisfies readonly Section[];

// Live TV (ADR-0066): not one of the six, so no ⌘ number. It joins the
// navs (lib/nav-sections) only while the profile has a source.
export const liveSection = {
  label: "Live TV",
  to: "/live",
  icon: RadioTower,
} as const satisfies Section;
