import { Link, useLocation } from "@tanstack/react-router";
import type { KeyboardEvent, MouseEvent } from "react";

import { ProfileMenu } from "@/components/shell/profile-menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { sections } from "@/sections";

const nextIndex: Record<string, (index: number, count: number) => number> = {
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

// Arrow keys, Home and End move focus between the nav's links.
function moveFocus(event: KeyboardEvent<HTMLAnchorElement>) {
  const move = nextIndex[event.key];
  const list = event.currentTarget.closest("ul");
  if (!move || !list) return;
  const links = [...list.querySelectorAll("a")];
  const index = links.indexOf(event.currentTarget);
  event.preventDefault();
  links[move(index, links.length)]?.focus();
}

// The six sections and the profile menu. An icon rail below the md
// breakpoint, with labels kept for screen readers and shown as tooltips.
export function Sidebar({ onKeyboardNavigate }: { onKeyboardNavigate: () => void }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  // One Tab stop for the whole nav (roving tabindex): the current section, or
  // Home when the page isn't one of them (Settings, Addons).
  const tabStop = Math.max(
    0,
    sections.findIndex((section) => section.to === pathname),
  );

  // A click with no pointer (detail 0) came from Enter on a focused link.
  const onClick = (event: MouseEvent) => {
    if (event.detail === 0) onKeyboardNavigate();
  };

  return (
    <aside className="drag-region row-start-2 flex w-14 flex-col gap-2 bg-sidebar p-2 text-sidebar-foreground md:w-52">
      <nav aria-label="Main" className="flex-1">
        <ul className="flex flex-col gap-0.5">
          {sections.map((section, index) => (
            <li key={section.to}>
              <Tooltip>
                <TooltipTrigger
                  delay={300}
                  render={
                    <Link
                      to={section.to}
                      activeOptions={{ exact: true }}
                      tabIndex={index === tabStop ? 0 : -1}
                      onClick={onClick}
                      onKeyDown={moveFocus}
                      className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium text-sidebar-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground [&_svg]:size-4.5 [&_svg]:shrink-0"
                    />
                  }
                >
                  <section.icon aria-hidden />
                  <span className="sr-only md:not-sr-only">{section.label}</span>
                </TooltipTrigger>
                <TooltipPopup side="right" className="md:hidden">
                  {section.label}
                </TooltipPopup>
              </Tooltip>
            </li>
          ))}
        </ul>
      </nav>
      <ProfileMenu />
    </aside>
  );
}
