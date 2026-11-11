import { Link, useRouterState } from "@tanstack/react-router";
import { Window } from "@wailsio/runtime";
import { Search } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { useBarOverArt } from "@/components/shell/bar-tone";
import { ConnectionStatus } from "@/components/shell/connection-status";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { WindowControls } from "@/components/shell/window-controls";
import { Wordmark } from "@/components/shell/wordmark";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { Platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { sections, type Section } from "@/sections";

// On screen the browse sections and Library sit together in the middle, and
// Search closes the row as a round button. ⌘1–6 keep sections.ts's order.
const search = sections.find((section) => section.to === "/search");
const visualOrder = [...sections.filter((section) => section !== search), search].filter(
  (section) => section !== undefined,
);

const nextIndex: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

// The nav is one Tab stop; arrow keys move along it, as in a toolbar.
function moveFocus(event: KeyboardEvent<HTMLAnchorElement>) {
  const move = nextIndex[event.key];
  const list = event.currentTarget.closest("ul");
  if (!move || !list) return;
  const links = [...list.querySelectorAll("a")];
  const index = links.indexOf(event.currentTarget);
  event.preventDefault();
  links[move(index, links.length)]?.focus();
}

// Room for the macOS traffic lights before the wordmark.
const leadingInset: Record<Platform, string> = {
  mac: "ps-[6.25rem]",
  windows: "ps-page",
  linux: "ps-page",
  browser: "ps-page",
};

// The window's top edge: the wordmark, the sections with a sun marking the
// current one, and the profile. At rest over a hero it is clear, with light
// text over a soft scrim; once the page scrolls under it, it frosts.
export function TopBar({
  platform,
  scrolled,
  onKeyboardNavigate,
}: {
  platform: Platform;
  scrolled: boolean;
  onKeyboardNavigate: () => void;
}) {
  const overArt = useBarOverArt();
  const clear = overArt && !scrolled;
  const pathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  });
  const current = visualOrder.findIndex((section) => section.to === pathname);
  const tabStop = current >= 0 ? current : 0;

  const onClick = (event: MouseEvent) => {
    if (event.detail === 0) onKeyboardNavigate();
  };

  const item = (section: Section, index: number) => {
    const active = pathname === section.to;
    if (section === search) {
      return (
        <li key={section.to} className="ms-1.5 flex">
          <Tooltip>
            <TooltipTrigger
              delay={400}
              render={
                <Link
                  to={section.to}
                  activeOptions={{ exact: true, includeSearch: false }}
                  tabIndex={index === tabStop ? 0 : -1}
                  onClick={onClick}
                  onKeyDown={moveFocus}
                  className={cn(
                    "relative grid size-8 place-items-center rounded-full outline-none transition-[background-color,color,scale] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-90 [&_svg]:size-4",
                    active
                      ? "bg-foreground text-background"
                      : "bg-foreground/8 text-foreground/80 hover:bg-foreground/14 hover:text-foreground",
                  )}
                />
              }
            >
              <Search aria-hidden strokeWidth={2.25} />
              <span className="sr-only">{section.label}</span>
              {active && <SunDot />}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Search{" "}
              <span className="text-muted-foreground">{platform === "mac" ? "⌘F" : "Ctrl+F"}</span>
            </TooltipPopup>
          </Tooltip>
        </li>
      );
    }
    return (
      <li key={section.to} className="flex">
        <Link
          to={section.to}
          activeOptions={{ exact: true, includeSearch: false }}
          tabIndex={index === tabStop ? 0 : -1}
          onClick={onClick}
          onKeyDown={moveFocus}
          className={cn(
            "relative flex h-8 items-center rounded-full px-3.5 text-[0.8125rem] font-[590] tracking-[-0.005em] outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
            active ? "text-foreground" : "text-foreground/60 hover:text-foreground",
          )}
        >
          {section.label}
          {active && <SunDot />}
        </Link>
      </li>
    );
  };

  return (
    <header
      data-slot="top-bar"
      data-platform={platform}
      data-tone={clear ? "art" : undefined}
      className={cn(
        "app-top-bar drag-region fixed inset-x-0 top-0 z-30 h-bar transition-[background-color,box-shadow] duration-(--duration-base)",
        clear && "dark",
        scrolled ? "material-bar shadow-[0_1px_0_var(--border)]" : "bg-transparent",
      )}
      onDoubleClick={(event) => {
        if (platform === "windows" && event.target === event.currentTarget) {
          void Window.ToggleMaximise();
        }
      }}
    >
      {/* Light text over bright art: a scrim from the top edge. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 -z-10 h-32 bg-linear-to-b from-black/60 via-black/25 to-transparent transition-opacity duration-(--duration-base)",
          clear ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        className={cn(
          "relative flex h-full items-center gap-4 pe-3 text-foreground",
          leadingInset[platform],
        )}
      >
        <div aria-hidden className="flex shrink-0 items-center max-sm:hidden">
          <Wordmark />
        </div>
        <nav aria-label="Main" className="pointer-events-none absolute inset-0 flex justify-center">
          <ul
            className={cn(
              "pointer-events-auto flex items-center self-center rounded-full p-0.5 transition-[background-color,box-shadow] duration-(--duration-base)",
              clear && "bg-black/30 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] backdrop-blur-xl",
            )}
          >
            {visualOrder.map(item)}
          </ul>
        </nav>
        <div className="ms-auto flex items-center gap-2">
          <ConnectionStatus />
          <ProfileMenu />
          {platform === "windows" && (
            <div className="-me-3 flex h-bar items-stretch">
              <WindowControls />
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// The current section's marker: a small sun under the label that glides to
// the next section on navigation (a shared view-transition name).
function SunDot() {
  return (
    <span
      aria-hidden
      data-slot="nav-sun"
      className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-sun shadow-sun [view-transition-name:nav-sun]"
    />
  );
}

// Screens before the app (welcome, sign-in, profiles): only the drag strip
// and, on Windows, the caption buttons.
export function FocusBar({ platform }: { platform: Platform }) {
  if (platform !== "mac" && platform !== "windows") return null;
  return (
    <div
      data-slot="top-bar"
      className="app-top-bar drag-region fixed inset-x-0 top-0 z-30 flex h-bar items-center justify-end"
    >
      {platform === "windows" && (
        <div className="flex h-full items-stretch">
          <WindowControls />
        </div>
      )}
    </div>
  );
}
