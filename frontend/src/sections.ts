import type { LinkProps } from "@tanstack/react-router";

export type Section = {
  label: string;
  to: NonNullable<LinkProps["to"]>;
};

// The top-level navigation. Capped at 6 items (epic #9); Settings, the
// profile switcher and addons live in the profile menu instead (#12).
export const sections = [
  { label: "Home", to: "/" },
  { label: "Movies", to: "/movies" },
  { label: "Shows", to: "/shows" },
  { label: "Anime", to: "/anime" },
  { label: "Search", to: "/search" },
  { label: "Library", to: "/library" },
] as const satisfies readonly Section[];
