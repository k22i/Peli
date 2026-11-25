import { skipToken, useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Folder, PanelLeft } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { capsuleGlass } from "@/components/shell/tab-bar";
import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import { folderParams, folderPath } from "@/lib/folder";
import { collectionsQuery } from "@/lib/home";
import { useNavSections } from "@/lib/nav-sections";
import { useCurrentProfile } from "@/lib/profile";
import { sectionOf } from "@/lib/tab-bar";
import { cn } from "@/lib/utils";
import { sections } from "@/sections";

// The sidebar's width and its gap to the screen's edges; the shell moves the
// page and the top bar over by --ipad-sidebar (app-shell.tsx).
export const sidebarInset = "[--ipad-sidebar:calc(env(safe-area-inset-left)+17rem)]";

// Search first, as a field-like row, then the sections in ⌘1–6 order.
const search = sections.find((section) => section.to === "/search")!;

// Arrow keys move along the sidebar's links, as in a list (and as the top
// capsule does); Tab leaves it.
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const step =
    event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? 0 : NaN;
  if (Number.isNaN(step) && event.key !== "End") return;
  const nav = event.currentTarget.closest("nav");
  const links = nav ? [...nav.querySelectorAll<HTMLAnchorElement>("a[data-sidebar-link]")] : [];
  const index = links.findIndex((link) => link === event.currentTarget);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? links.length - 1
        : (index + step + links.length) % links.length;
  links[next]?.focus();
}

const row =
  "flex h-11 items-center gap-3 rounded-xl px-3 text-[0.9375rem] font-[560] outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-5 [&_svg]:shrink-0";
const rowIdle = "text-foreground/80 hover:bg-foreground/8 hover:text-foreground";
const rowActive = "bg-foreground/10 text-sun-ink";

// The iPad's sidebar at regular width (#138): a floating glass panel on the
// left, as iPadOS 26's sidebar-adaptable tab bars become, holding the
// sections and the profile's Nuvio Collections (their folders open the
// folder page, #96). The sidebar button (⌃⌘S) folds it back into the top
// capsule; the choice is kept per device (lib/sidebar-choice.ts). CSS glass
// (ADR-0046), decided by the user on 2026-11-18 over a native panel.
export function IPadSidebar({
  onHide,
  onKeyboardNavigate,
}: {
  onHide: () => void;
  onKeyboardNavigate: () => void;
}) {
  const profile = useCurrentProfile();
  // Before there is a profile (the guest placeholder has no id), none.
  const profileId = profile.id;
  const collections = useQuery(
    profileId === undefined
      ? { queryKey: ["collections", "none"], queryFn: skipToken }
      : collectionsQuery(profileId),
  );
  const pathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  });
  const current = sectionOf(pathname, undefined);
  const navSections = useNavSections();
  const ordered = [search, ...navSections.filter((section) => section !== search)];
  const onClick = (event: MouseEvent) => {
    if (event.detail === 0) onKeyboardNavigate();
  };
  const withFolders = (collections.data ?? []).filter((each) => (each.folders?.length ?? 0) > 0);

  return (
    <nav
      aria-label="Main"
      data-slot="ipad-sidebar"
      className={cn(
        capsuleGlass,
        "fixed start-[calc(env(safe-area-inset-left)+0.5rem)] top-[calc(env(safe-area-inset-top)+0.5rem)] bottom-[max(env(safe-area-inset-bottom),0.5rem)] z-30 flex w-64 flex-col overflow-hidden rounded-[1.75rem] [view-transition-name:ipad-sidebar]",
      )}
    >
      <div className="flex h-14 shrink-0 items-center justify-between ps-4 pe-2">
        <span aria-hidden>
          <Wordmark />
        </span>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Hide sidebar"
          aria-keyshortcuts="Control+Meta+S"
          onClick={onHide}
          className="size-11 rounded-full"
        >
          <PanelLeft className="size-5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        <ul className="flex flex-col gap-0.5">
          {ordered.map((section) => {
            const active = current === section;
            const Icon = section.icon;
            return (
              <li key={section.to} className={cn(section === search && "mb-2")}>
                <Link
                  to={section.to}
                  data-sidebar-link
                  aria-current={active ? "page" : undefined}
                  onClick={onClick}
                  onKeyDown={moveFocus}
                  className={cn(
                    row,
                    section === search && "bg-foreground/6",
                    active ? rowActive : rowIdle,
                  )}
                >
                  <Icon aria-hidden strokeWidth={2} />
                  <span className="truncate">{section.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        {withFolders.map((collection) => (
          <section key={collection.id} aria-label={collection.title} className="mt-4">
            <h2 className="px-3 pb-1 text-[0.75rem] font-[600] tracking-[0.02em] text-muted-foreground uppercase">
              {collection.title}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {(collection.folders ?? []).map((folder) => {
                const params = folderParams(collection, folder);
                const active =
                  pathname === `/folder/${params.collectionId}/${params.folderId}` ||
                  pathname ===
                    `/folder/${encodeURIComponent(params.collectionId)}/${encodeURIComponent(params.folderId)}`;
                return (
                  <li key={folder.id}>
                    <Link
                      to={folderPath}
                      params={params}
                      data-sidebar-link
                      aria-current={active ? "page" : undefined}
                      onClick={onClick}
                      onKeyDown={moveFocus}
                      className={cn(row, "h-10 text-[0.875rem]", active ? rowActive : rowIdle)}
                    >
                      {folder.emoji ? (
                        <span aria-hidden className="w-5 shrink-0 text-center text-[1.0625rem]">
                          {folder.emoji}
                        </span>
                      ) : (
                        <Folder aria-hidden strokeWidth={2} />
                      )}
                      <span className="truncate">{folder.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}

// The top bar's sidebar button, while the top capsule shows.
export function ShowSidebarButton({ onShow, overArt }: { onShow: () => void; overArt: boolean }) {
  return (
    <Button
      variant={overArt ? "media" : "ghost"}
      size="icon-lg"
      aria-label="Show sidebar"
      aria-keyshortcuts="Control+Meta+S"
      onClick={onShow}
      className="size-11 shrink-0 rounded-full"
    >
      <PanelLeft className="size-5" />
    </Button>
  );
}
