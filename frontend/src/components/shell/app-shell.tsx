import { useMatches, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { lastOpenPane } from "@/components/settings/panes";
import { Sidebar } from "@/components/shell/sidebar";
import { TitleBar } from "@/components/shell/title-bar";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { currentPlatform, type Platform } from "@/lib/platform";
import { searchFieldId } from "@/lib/search";
import { cn } from "@/lib/utils";
import { sections } from "@/sections";

// The height of the title bar strip: where the macOS traffic lights or the
// Windows caption buttons sit. Linux keeps its native frame.
const titleBarHeight: Record<Platform, string> = {
  mac: "[--titlebar-h:2.75rem]",
  windows: "[--titlebar-h:2rem]",
  linux: "[--titlebar-h:0px]",
  browser: "[--titlebar-h:0px]",
};

// How far the content pane has to scroll before the title bar shows its
// scroll edge, so the hero art reaches the top of the window at rest.
const scrolledAfterPx = 4;

// The window frame every route renders in: a content pane that fills the
// window and scrolls under a floating glass sidebar and the title bar (#114).
// The pane pads itself by --sidebar-inset and --titlebar-h, so pages keep
// clear of the chrome; full-bleed artwork opts out with the `bleed` utility.
// Only the content pane changes on navigation, so the shell never shifts. All
// backgrounds live here rather than on <body>, so a route with
// `staticData.chrome: "none"` gets a bare, transparent page.
export function AppShell({ children }: { children: ReactNode }) {
  const chrome = useMatches({
    select: (matches) => matches.findLast((match) => match.staticData.chrome)?.staticData.chrome,
  });
  const content = useRef<HTMLDivElement | null>(null);
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const focusPending = useRef(false);
  const router = useRouter();
  const navigate = useNavigate();
  const scrolled = useScrolled(pane);
  // A stable callback: a new one each render would null and set the state
  // again, forever.
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    content.current = node;
    setPane(node);
  }, []);

  // After a keyboard navigation, move focus to the new page so the next Tab
  // lands in it rather than back in the nav.
  const focusContentAfterNavigate = useCallback(() => {
    focusPending.current = true;
  }, []);

  useEffect(
    () =>
      router.subscribe("onRendered", () => {
        if (!focusPending.current) return;
        focusPending.current = false;
        // Unless the page took it itself, as Search's field does.
        if (content.current?.contains(document.activeElement)) return;
        content.current?.focus({ preventScroll: true });
      }),
    [router],
  );

  // Ctrl/⌘+1–6 jump to a section, and Ctrl/⌘+, opens Settings, as it does
  // in other apps. Ctrl/⌘+F, or / outside a text field, goes to Search's
  // field (#44).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isSearchShortcut(event)) {
        event.preventDefault();
        const field = document.getElementById(searchFieldId);
        if (field instanceof HTMLInputElement) {
          field.focus();
          field.select();
        } else {
          // Its field takes focus when the page opens.
          void navigate({ to: "/search" });
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const to = event.key === "," ? "/settings" : sections[Number(event.key) - 1]?.to;
      if (!to) return;
      event.preventDefault();
      focusContentAfterNavigate();
      // Settings opens at the pane last used this run (#120).
      void navigate(
        event.key === "," ? { to: "/settings", search: { section: lastOpenPane() } } : { to },
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, focusContentAfterNavigate]);

  if (chrome === "none") return children;

  const platform = currentPlatform();

  if (chrome === "focus") {
    return (
      <div className={cn("h-svh bg-background text-foreground", titleBarHeight[platform])}>
        <TitleBar platform={platform} />
        <main className="size-full overflow-y-auto pt-(--titlebar-h)">{children}</main>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "h-svh bg-background text-foreground [--sidebar-inset:calc(4rem+1rem)] md:[--sidebar-inset:calc(15rem+1rem)]",
        titleBarHeight[platform],
      )}
    >
      <a
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        className="sr-only z-50 glass rounded-lg px-3 py-2 text-sm outline-none focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to content
      </a>
      <TitleBar platform={platform} scrolled={scrolled} />
      <Sidebar onKeyboardNavigate={focusContentAfterNavigate} />
      <main className="content-pane fixed inset-0 overflow-hidden bg-background">
        {/* Overlay scrollbars, the same on every OS (WebView2 would draw
            classic ones), and never taking width from the page. */}
        <ScrollAreaPrimitive.Root className="size-full">
          <ScrollAreaPrimitive.Viewport
            ref={contentRef}
            id="content"
            data-scroll-restoration-id="content"
            data-scrolled={scrolled || undefined}
            // Focusable for keyboard scrolling and for focus after navigation,
            // but not an extra Tab stop.
            tabIndex={-1}
            className="size-full outline-none"
          >
            {/* As coss's ScrollArea does: pages wrap to the pane's width. The
                padding keeps pages clear of the floating sidebar and the title
                bar; `bleed` artwork reaches under them. */}
            <ScrollAreaPrimitive.Content
              style={{ minWidth: 0 }}
              className="ps-(--sidebar-inset) pt-(--titlebar-h)"
            >
              {children}
            </ScrollAreaPrimitive.Content>
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar orientation="vertical" className="mt-[calc(var(--titlebar-h)+0.25rem)]" />
        </ScrollAreaPrimitive.Root>
      </main>
    </div>
  );
}

// Whether the content pane is scrolled past the top, to show the title bar's
// scroll edge. A passive listener, throttled to a frame.
function useScrolled(pane: HTMLElement | null) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!pane) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(pane.scrollTop > scrolledAfterPx);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      pane.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [pane]);

  return scrolled;
}

function isSearchShortcut(event: KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (event.ctrlKey || event.metaKey) return event.key.toLowerCase() === "f";
  if (event.key !== "/") return false;
  const target = event.target;
  return !(
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
