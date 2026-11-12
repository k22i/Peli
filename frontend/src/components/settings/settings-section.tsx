import { Link, useNavigate } from "@tanstack/react-router";
import { useId, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { ChipRail, Chip } from "@/components/media/chip";
import { visiblePanes, type PaneId } from "@/components/settings/panes";
import { cn } from "@/lib/utils";

export const paneHeadingId = "settings-pane-title";

// One pane of settings, like a pane in macOS System Settings: its title, an
// optional lead paragraph, then its groups. The title takes focus when the
// pane list changes the pane from the keyboard (see Settings).
export function SettingsPaneView({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={paneHeadingId}
      className="flex min-w-0 flex-col gap-9 md:pt-[4.25rem]"
    >
      <header className="flex flex-col gap-2">
        <h2 id={paneHeadingId} tabIndex={-1} className="type-title outline-none">
          {title}
        </h2>
        {lead && <p className="max-w-prose text-body text-pretty text-muted-foreground">{lead}</p>}
      </header>
      {children}
    </section>
  );
}

// A group of rows (Apple-style): a small title above an inset list, and an
// optional note under it. Without a title the list stands alone.
export function SettingsGroup({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={title ? titleId : undefined} className="flex flex-col gap-2">
      {title && (
        <h3 id={titleId} className="px-1 type-eyebrow text-muted-foreground">
          {title}
        </h3>
      )}
      <div className="flex flex-col divide-y divide-border rounded-2xl bg-card hairline">
        {children}
      </div>
      {footer && <p className="px-1 text-small text-pretty text-muted-foreground">{footer}</p>}
    </section>
  );
}

// A setting: its label and what it does on the left, the control on the right.
// The control names itself with aria-labelledby={`${id}-label`} and
// aria-describedby={`${id}-description`}.
export function SettingRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-3.5">
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <span id={`${id}-label`} className="type-item">
          {label}
        </span>
        {description && (
          <p
            id={`${id}-description`}
            className="max-w-prose text-small text-pretty text-muted-foreground"
          >
            {description}
          </p>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

const nextIndex: Record<string, (index: number, count: number) => number> = {
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

// Arrow keys, Home and End move focus between the list's links, as they do in
// the sidebar. Enter then opens the pane.
function moveFocus(event: KeyboardEvent<HTMLAnchorElement>) {
  const move = nextIndex[event.key];
  const list = event.currentTarget.closest("ul");
  if (!move || !list) return;
  const links = [...list.querySelectorAll("a")];
  const index = links.indexOf(event.currentTarget);
  event.preventDefault();
  links[move(index, links.length)]?.focus();
}

// The panes, as a list on the left (md and up). Links to `?section=`: the
// router uses the URL hash, so "#playback" would be read as a route. The
// current pane is the one Tab stop; arrows move between panes.
//
// The active item's background is its own element (`data-settings-pill`),
// named for the view transition, so it glides to the next pane (#124).
export function SettingsPaneList({
  current,
  onNavigate,
  className,
}: {
  current: PaneId;
  // Called on every click; `viaKeyboard` is true for Enter on a focused link.
  onNavigate: (viaKeyboard: boolean) => void;
  className?: string;
}) {
  // A click with no pointer (detail 0) came from Enter on a focused link.
  const onClick = (event: MouseEvent) => onNavigate(event.detail === 0);

  return (
    <nav
      aria-label="Settings panes"
      className={cn("[view-transition-name:settings-nav]", className)}
    >
      <ul className="flex flex-col gap-0.5">
        {visiblePanes().map((pane) => {
          const active = pane.id === current;
          return (
            <li key={pane.id}>
              <Link
                to="/settings"
                search={{ section: pane.id }}
                replace
                tabIndex={active ? 0 : -1}
                aria-current={active ? "page" : undefined}
                data-status={active ? "active" : undefined}
                onClick={onClick}
                onKeyDown={moveFocus}
                className="group/pane relative flex h-9 items-center gap-3 rounded-full px-3.5 text-small font-[590] text-muted-foreground outline-none transition-[color,scale] duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.98] data-[status=active]:text-foreground"
              >
                {active && (
                  <span
                    aria-hidden
                    data-settings-pill
                    className="absolute inset-0 rounded-full bg-foreground/8 [view-transition-name:settings-pill]"
                  />
                )}
                <pane.icon
                  aria-hidden
                  className={cn("relative size-4 shrink-0", active && "text-sun-ink")}
                />
                <span className="relative truncate">{pane.title}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// The same panes as a chip rail that scrolls sideways, for windows narrower
// than md (#116).
export function SettingsPaneRail({ current, className }: { current: PaneId; className?: string }) {
  const navigate = useNavigate();
  return (
    <ChipRail
      aria-label="Settings panes"
      value={[current]}
      onValueChange={([next]) => {
        // Pressing the current chip would clear the group; keep it.
        const pane = visiblePanes().find((candidate) => candidate.id === next);
        if (pane) void navigate({ to: "/settings", search: { section: pane.id }, replace: true });
      }}
      railClassName={cn("-mx-page w-[calc(100%+2*var(--spacing-page))]", className)}
    >
      {visiblePanes().map((pane) => (
        <Chip key={pane.id} value={pane.id}>
          {pane.title}
        </Chip>
      ))}
    </ChipRail>
  );
}
