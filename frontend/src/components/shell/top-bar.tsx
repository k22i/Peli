import { Link, useCanGoBack, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { Window } from "@wailsio/runtime";
import { ChevronLeft, Search } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { useBarOverArt } from "@/components/shell/bar-tone";
import { ConnectionStatus } from "@/components/shell/connection-status";
import { ShowSidebarButton } from "@/components/shell/ipad-sidebar";
import { PartyStatus } from "@/components/shell/party-status";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { UpdateStatus } from "@/components/shell/update-status";
import { capsuleGlass } from "@/components/shell/tab-bar";
import { WindowControls } from "@/components/shell/window-controls";
import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useHardwareKeyboard } from "@/lib/input-devices";
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

// Detail pages that take Back in the compact bar (#136).
const detailPage = /^\/(title|streams)\//;

// The phone's Back: the bar's left end on a title page or the stream picker,
// a 44 pt glass circle opposite the avatar. Over art it is media glass.
function BackLink({ overArt, fallback = "/" }: { overArt: boolean; fallback?: "/" | "/settings" }) {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return (
    <Button
      variant={overArt ? "media" : "ghost"}
      size="icon-lg"
      aria-label="Back"
      data-over-art={overArt || undefined}
      onClick={() => (canGoBack ? router.history.back() : void navigate({ to: fallback }))}
      className={cn(
        "size-11 shrink-0 sm:size-11",
        !overArt && "material-pop text-popover-foreground hover:bg-popover",
      )}
    >
      <ChevronLeft className="size-5" strokeWidth={2.25} />
    </Button>
  );
}

// Room for the macOS traffic lights before the wordmark.
const leadingInset: Record<Platform, string> = {
  mac: "ps-[6.25rem]",
  windows: "ps-page",
  linux: "ps-page",
  ios: "ps-page",
  browser: "ps-page",
};

// The window's top edge: the wordmark, the sections with a sun marking the
// current one, and the profile. At rest over a hero it is clear, with light
// text over a soft scrim; once the page scrolls under it, it frosts.
export function TopBar({
  platform,
  scrolled,
  compact = false,
  ipad,
  onKeyboardNavigate,
}: {
  platform: Platform;
  scrolled: boolean;
  // The iOS tab bar holds the sections and Search (#129); the bar keeps the
  // wordmark and the profile.
  compact?: boolean;
  // The iOS app at regular width (#138): the sections float in a glass
  // capsule under the status bar, with a sidebar button at the leading end;
  // with the sidebar shown, the bar starts beside it and leaves the sections
  // and the wordmark to it.
  ipad?: { sidebar: boolean; onShowSidebar: () => void } | undefined;
  onKeyboardNavigate: () => void;
}) {
  const overArt = useBarOverArt();
  // ⌘F in Search's tooltip on an iPad only with a keyboard to press it on.
  const keyboard = useHardwareKeyboard();
  const clear = overArt && !scrolled;
  const pathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  });
  // A Settings pane (`?section=`) is pushed over the pane list on the phone
  // (#137), so it takes Back like a detail page.
  const inPane = useRouterState({
    select: (state) => {
      const location = state.resolvedLocation ?? state.location;
      return location.pathname === "/settings" && "section" in (location.search as object);
    },
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
                    "relative grid size-8 place-items-center rounded-full pointer-coarse:size-11 outline-none transition-[background-color,color,scale] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-90 [&_svg]:size-4",
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
              {(platform !== "ios" || keyboard) && (
                <span className="text-muted-foreground">
                  {platform === "mac" ? "⌘F" : "Ctrl+F"}
                </span>
              )}
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
            "relative flex h-8 items-center rounded-full px-3.5 pointer-coarse:h-11 text-[0.8125rem] font-[590] tracking-[-0.005em] outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
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
        // On iOS the bar starts at the screen's top edge, under the status bar
        // (--spacing-bar includes it there); the env() insets are 0 elsewhere.
        "app-top-bar drag-region fixed top-0 z-30 h-bar pt-[env(safe-area-inset-top)] pe-[env(safe-area-inset-right)] transition-[background-color,box-shadow] duration-(--duration-base)",
        ipad?.sidebar ? "start-(--ipad-sidebar) end-0" : "inset-x-0",
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
        {compact && (detailPage.test(pathname) || inPane) && (
          <BackLink overArt={clear} fallback={inPane ? "/settings" : "/"} />
        )}
        {ipad && !ipad.sidebar && <ShowSidebarButton overArt={clear} onShow={ipad.onShowSidebar} />}
        {!ipad?.sidebar && (
          <div
            aria-hidden
            // On an iPad narrower than 1024 pt the capsule needs the room.
            className={cn("flex shrink-0 items-center max-sm:hidden", ipad && "max-lg:hidden")}
          >
            <Wordmark />
          </div>
        )}
        {!compact && !ipad?.sidebar && (
          <nav
            aria-label="Main"
            className="pointer-events-none absolute inset-0 flex justify-center"
          >
            <ul
              className={cn(
                "pointer-events-auto flex items-center self-center rounded-full p-0.5 transition-[background-color,box-shadow] duration-(--duration-base)",
                // The iPad's floating capsule: always glass, a touch taller.
                ipad
                  ? cn(capsuleGlass, "p-1")
                  : clear &&
                      "bg-black/30 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] backdrop-blur-xl",
              )}
            >
              {visualOrder.map(item)}
            </ul>
          </nav>
        )}
        <div className="ms-auto flex items-center gap-2">
          <ConnectionStatus />
          <PartyStatus />
          <UpdateStatus />
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
