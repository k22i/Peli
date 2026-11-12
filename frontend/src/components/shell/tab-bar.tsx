import { Link, useRouterState } from "@tanstack/react-router";

import { cn } from "@/lib/utils";
import { sections } from "@/sections";

// Search is the round button in the top strip, as on the desktop bar; the
// tab bar holds the other sections.
export const tabSections = sections.filter((section) => section.to !== "/search");

// The compact shell's navigation (iPhone, a narrow iPad window): the
// sections along the bottom edge in the bar material, the current one in
// sun. Tabs are at least 44 pt tall and a finger wide; the tab bar sits
// above the home indicator (the webview is laid out inside the safe area, and
// the inset below covers a webview that isn't).
export function TabBar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  });
  return (
    <nav
      aria-label="Main"
      data-slot="tab-bar"
      className="material-bar fixed inset-x-0 bottom-0 z-30 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_var(--border)]"
    >
      <ul className="mx-auto flex h-tabs max-w-xl items-stretch">
        {tabSections.map((section) => {
          const active = pathname === section.to;
          const Icon = section.icon;
          return (
            <li key={section.to} className="flex min-w-0 flex-1">
              <Link
                to={section.to}
                activeOptions={{ exact: true, includeSearch: false }}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[0.625rem] font-[590] tracking-[0.01em] outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-95 [&_svg]:size-[1.375rem]",
                  active ? "text-sun-ink" : "text-foreground/60",
                )}
              >
                <Icon aria-hidden strokeWidth={active ? 2.25 : 1.75} />
                <span className="truncate">{section.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
