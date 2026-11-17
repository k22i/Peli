import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import { ChipRail, Chip } from "@/components/media/chip";
import { visiblePaneGroups, visiblePanes, type PaneId } from "@/components/settings/panes";
import { useCurrentProfile } from "@/lib/profile";
import { useCompactShell } from "@/lib/shell-mode";
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
  const compact = useCompactShell();
  if (compact) {
    return (
      <CompactPage title={title} headingId={paneHeadingId} lead={lead}>
        {children}
      </CompactPage>
    );
  }
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
  const compact = useCompactShell();
  return (
    <section aria-labelledby={title ? titleId : undefined} className="flex flex-col gap-2">
      {title && (
        <h3
          id={titleId}
          className={cn("px-1 type-eyebrow text-muted-foreground", compact && "ps-4 text-[13px]")}
        >
          {title}
        </h3>
      )}
      <div
        className={cn(
          "flex flex-col divide-y divide-border bg-card hairline",
          // An inset-grouped list: 12 pt corners, and rows that start 16 pt
          // in, as in the iOS Settings app (#137).
          compact ? "rounded-xl" : "rounded-2xl",
        )}
      >
        {children}
      </div>
      {footer && (
        <p
          className={cn(
            "px-1 text-small text-pretty text-muted-foreground",
            compact && "px-4 text-[13px] leading-[1.35]",
          )}
        >
          {footer}
        </p>
      )}
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
  const compact = useCompactShell();
  if (compact) {
    // The label (17 pt) and a short detail line (13 pt) on the left, the
    // control at the end, never wrapped under it. A long description is a
    // paragraph under the row, as an iOS footer is; a select shows its value
    // and a chevron, and opens a sheet.
    const long = typeof description === "string" && description.length > longDescription;
    return (
      <div className="flex flex-col px-4">
        <div className="flex min-h-11 items-center justify-between gap-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col">
            <span id={`${id}-label`} className="text-[17px] leading-[22px]">
              {label}
            </span>
            {description && !long && (
              <p
                id={`${id}-description`}
                className="text-[13px] leading-[1.3] text-pretty text-muted-foreground"
              >
                {description}
              </p>
            )}
          </div>
          {children && (
            <div className="flex max-w-[55%] shrink-0 items-center gap-2 [&_[data-slot=select-trigger]]:w-auto [&_[data-slot=select-trigger]]:min-w-0 [&_[data-slot=select-trigger]]:max-w-full [&_[data-slot=select-trigger]]:bg-transparent [&_[data-slot=select-trigger]]:ps-2 [&_[data-slot=select-trigger]]:text-[17px] [&_[data-slot=select-trigger]]:font-normal [&_[data-slot=select-trigger]]:text-muted-foreground">
              {children}
            </div>
          )}
        </div>
        {description && long && (
          <p
            id={`${id}-description`}
            className="pb-3 text-[13px] leading-[1.35] text-pretty text-muted-foreground"
          >
            {description}
          </p>
        )}
      </div>
    );
  }
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

// A description longer than this goes under its row, full width.
const longDescription = 64;

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

// The phone's page: a 34 pt large title that, scrolled under the top strip,
// becomes a 17 pt title in a 44 pt glass bar (the iOS navigation bar, as in
// the Library, #132). Back is the top strip's (top-bar.tsx) on a pane.
export function CompactPage({
  title,
  headingId,
  lead,
  level = 2,
  children,
}: {
  title: string;
  headingId?: string | undefined;
  lead?: ReactNode;
  level?: 1 | 2;
  children: ReactNode;
}) {
  const bar = useRef<HTMLDivElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const Heading = level === 1 ? "h1" : "h2";

  // The small title shows once the large one is wholly under the bar.
  useEffect(() => {
    const target = heading.current;
    const element = bar.current;
    if (!target || !element || typeof IntersectionObserver === "undefined") return undefined;
    const top = Number.parseFloat(getComputedStyle(element).top) || 0;
    const observer = new IntersectionObserver(
      (entries) => setCollapsed(!entries[entries.length - 1]!.isIntersecting),
      { rootMargin: `-${top + element.offsetHeight}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <section aria-labelledby={headingId} className="relative flex min-w-0 flex-col gap-6 pb-8">
      <div
        ref={bar}
        aria-hidden
        data-collapsed={collapsed || undefined}
        className="group/bar pointer-events-none sticky top-(--spacing-bar) z-10 -mx-page -mb-[4.25rem] flex h-11 items-center justify-center transition-[background-color,box-shadow] duration-(--duration-base) data-collapsed:material-bar data-collapsed:shadow-[0_1px_0_var(--border)]"
      >
        <span className="text-[1.0625rem] font-[590] opacity-0 transition-opacity duration-(--duration-fast) group-data-collapsed/bar:opacity-100">
          {title}
        </span>
      </div>
      <header className="flex flex-col gap-2 pt-1">
        <Heading
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className="min-h-11 font-display text-[2.125rem] leading-[1.1] tracking-[-0.01em] outline-none"
        >
          {title}
        </Heading>
        {lead && <p className="text-[15px] text-pretty text-muted-foreground">{lead}</p>}
      </header>
      {children}
    </section>
  );
}

// The phone's Settings root: the profile, then the panes in groups, each a
// row with a coloured icon and a chevron. A row pushes `?section=` (the
// directional transition is the router's); Back returns here.
export function SettingsRoot() {
  const profile = useCurrentProfile();
  return (
    <CompactPage title="Settings" level={1}>
      <Link
        to="/profiles"
        className="flex min-h-[4.5rem] items-center gap-3.5 rounded-xl bg-card px-4 py-3 text-start outline-none hairline focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:bg-foreground/6"
      >
        <ProfileAvatar profile={profile} className="size-14" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[20px] leading-[1.2] font-[590]">{profile.name}</span>
          <span className="text-[15px] leading-[1.3] text-muted-foreground">Switch profile</span>
        </span>
        <ChevronRight aria-hidden className="size-5 shrink-0 text-foreground/35" />
      </Link>
      <nav aria-label="Settings panes" className="flex flex-col gap-6">
        {visiblePaneGroups().map((group) => (
          <ul
            key={group.map((pane) => pane.id).join()}
            className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card hairline"
          >
            {group.map((pane) => (
              <li key={pane.id}>
                <Link
                  to="/settings"
                  search={{ section: pane.id }}
                  className="flex min-h-12 items-center gap-3.5 ps-4 pe-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-safe:active:bg-foreground/6"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-[29px] shrink-0 place-items-center rounded-[7px] text-white",
                      pane.tone,
                    )}
                  >
                    <pane.icon className="size-[18px]" strokeWidth={2} />
                  </span>
                  <span className="flex-1 truncate text-[17px]">{pane.title}</span>
                  <ChevronRight aria-hidden className="size-5 shrink-0 text-foreground/35" />
                </Link>
              </li>
            ))}
          </ul>
        ))}
      </nav>
    </CompactPage>
  );
}
