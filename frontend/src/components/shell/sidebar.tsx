import { Link, useRouterState } from "@tanstack/react-router";
import type { KeyboardEvent, MouseEvent } from "react";

import { ConnectionStatus } from "@/components/shell/connection-status";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { currentPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { sections, type Section } from "@/sections";

const nextIndex: Record<string, (index: number, count: number) => number> = {
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

// Arrow keys, Home and End move focus between the nav's links, in the order
// they are on screen.
function moveFocus(event: KeyboardEvent<HTMLAnchorElement>) {
  const move = nextIndex[event.key];
  const list = event.currentTarget.closest("ul");
  if (!move || !list) return;
  const links = [...list.querySelectorAll("a")];
  const index = links.indexOf(event.currentTarget);
  event.preventDefault();
  links[move(index, links.length)]?.focus();
}

// What the sidebar shows, top to bottom: Search as a field, the browse
// sections, a gap, then Library. Only the look moves; Ctrl/⌘+1–6 follow
// sections.ts.
const search = sections.find((section) => section.to === "/search");
const library = sections.find((section) => section.to === "/library");
const browse = sections.filter((section) => section !== search && section !== library);
const visualOrder = [search, ...browse, library].filter((section) => section !== undefined);

const itemClass =
  "group/item relative isolate flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-[550] text-sidebar-foreground outline-none transition-[scale] duration-(--duration-fast) hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.99] data-[status=active]:text-foreground data-[status=active]:hover:bg-transparent [&_svg]:size-5 [&_svg]:shrink-0 data-[status=active]:[&_svg]:text-brand";

// Search is the entry to a field (Apple Music style): a link that looks like
// one, with its shortcut on the right. Below md it is an icon like the rest.
const searchClass =
  "group/item relative isolate flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm text-muted-foreground outline-none transition-[scale] duration-(--duration-fast) glass-thin hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.99] data-[status=active]:text-foreground [&_svg]:size-4.5 [&_svg]:shrink-0 data-[status=active]:[&_svg]:text-brand max-md:h-10 max-md:justify-center max-md:px-0";

// The six sections, the offline indicator and the profile menu, in a glass
// panel floating inset from the window's edges (#114). An icon rail below the
// md breakpoint, with labels kept for screen readers and shown as tooltips.
export function Sidebar({ onKeyboardNavigate }: { onKeyboardNavigate: () => void }) {
  // The page on screen, not the one being navigated to: the pill moves when
  // the route commits, inside its view transition, so it glides (#124).
  const pathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  });
  const mac = currentPlatform() === "mac";
  // One Tab stop for the whole nav (roving tabindex): the current section, or
  // Home when the page isn't one of them (Settings, Addons).
  const current = visualOrder.findIndex((section) => section.to === pathname);
  const tabStop = current >= 0 ? current : visualOrder.findIndex((section) => section.to === "/");

  // A click with no pointer (detail 0) came from Enter on a focused link.
  const onClick = (event: MouseEvent) => {
    if (event.detail === 0) onKeyboardNavigate();
  };

  const item = (section: Section, index: number) => {
    const isSearch = section === search;
    return (
      <li key={section.to} className={cn(section === library && "mt-4")}>
        <Tooltip>
          <TooltipTrigger
            delay={300}
            render={
              <Link
                to={section.to}
                // Path only: a chip or filter changes the search, and the
                // section stays the one you're in.
                activeOptions={{ exact: true, includeSearch: false }}
                tabIndex={index === tabStop ? 0 : -1}
                onClick={onClick}
                onKeyDown={moveFocus}
                className={isSearch ? searchClass : itemClass}
              />
            }
          >
            {pathname === section.to && (
              <span
                aria-hidden
                data-slot="nav-pill"
                className="absolute inset-0 -z-10 rounded-xl bg-brand-soft [view-transition-name:nav-pill]"
              />
            )}
            <section.icon aria-hidden />
            <span className="sr-only md:not-sr-only">{section.label}</span>
            {isSearch && (
              <Kbd aria-hidden className="ms-auto hidden md:inline-flex">
                {mac ? "⌘F" : "Ctrl+F"}
              </Kbd>
            )}
          </TooltipTrigger>
          <TooltipPopup side="right" className="md:hidden">
            {section.label}
          </TooltipPopup>
        </Tooltip>
      </li>
    );
  };

  return (
    <aside
      className={cn(
        "drag-region fixed start-2 top-2 bottom-2 z-30 [view-transition-name:sidebar] flex w-16 flex-col gap-2 rounded-[1.25rem] p-2 text-sidebar-foreground glass-thick md:w-60",
        // Room for the traffic lights, which sit in the panel's top-left.
        mac && "pt-11",
      )}
    >
      <nav aria-label="Main" className="flex-1 [view-transition-name:sidebar-nav]">
        <ul className="flex flex-col gap-1">{visualOrder.map(item)}</ul>
      </nav>
      <ConnectionStatus />
      <ProfileMenu />
    </aside>
  );
}
