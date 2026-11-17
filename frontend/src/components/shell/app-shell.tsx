import { useMatches, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { lastOpenPane } from "@/components/settings/panes";
import { TabBar } from "@/components/shell/tab-bar";
import { useNativeTabBar, useTabBar } from "@/components/shell/use-tab-bar";
import { CommandPalette } from "@/components/shell/command-palette";
import { FocusBar, TopBar } from "@/components/shell/top-bar";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { useSeedAudioLanguages } from "@/lib/device-languages";
import { feature } from "@/lib/features";
import { useDismissKeyboardOnScroll, useKeyboardInset } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { currentPlatform } from "@/lib/platform";
import { searchFieldId } from "@/lib/search";
import { useCompactShell } from "@/lib/shell-mode";
import { sections } from "@/sections";

// How far the content pane has to scroll before the top bar frosts, so a
// hero's art reaches the top of the window at rest.
const scrolledAfterPx = 4;

// The window frame every route renders in: a top bar over a content pane
// that fills the window. Pages start below the bar (the pane pads by
// --spacing-bar); a full-bleed hero pulls itself up under it with
// `under-bar`. Only the pane changes on navigation, so the bar never shifts.
// Backgrounds live here rather than on <body>, so a route with
// `staticData.chrome: "none"` (the player) gets a bare, transparent page.
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
  const compact = useCompactShell();
  // The floating tab bar (#129): only in the browsing chrome at compact
  // width, so it is gone on the player and the focus screens. Native Liquid
  // Glass on iOS 26, else TabBar's CSS capsule.
  const tabsShown = compact && chrome === undefined;
  const tabBar = useTabBar(tabsShown ? pane : null, tabsShown);
  useNativeTabBar(tabBar, tabsShown);
  const nativeTabs = feature("nativeTabBar");
  useSeedAudioLanguages();
  // --keyboard-h while the on-screen keyboard is up (iOS, #137).
  useKeyboardInset();
  // Scrolling a list closes the keyboard, as iOS lists do.
  useDismissKeyboardOnScroll(pane, compact);
  // Toasts lift above the floating bar while it shows (index.css, #132).
  useEffect(() => {
    document.documentElement.toggleAttribute("data-tabs", tabsShown);
    return () => document.documentElement.removeAttribute("data-tabs");
  }, [tabsShown]);
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
      <div className="grain h-svh bg-background text-foreground">
        <FocusBar platform={platform} />
        <main className="size-full overflow-y-auto">{children}</main>
      </div>
    );
  }

  return (
    <div className="grain h-svh bg-background text-foreground">
      <a
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        className="sr-only z-50 rounded-full bg-foreground px-4 py-2 text-small font-semibold text-background outline-none focus:not-sr-only focus:fixed focus:start-1/2 focus:top-2 focus:-translate-x-1/2"
      >
        Skip to content
      </a>
      <TopBar
        platform={platform}
        scrolled={scrolled}
        compact={compact}
        onKeyboardNavigate={focusContentAfterNavigate}
      />
      {/* Not in the other chromes: the player's has none, and the focus
          screens come before there is a profile. */}
      {feature("commandPalette") && <CommandPalette onNavigate={focusContentAfterNavigate} />}
      <main className="page-layer fixed inset-0 overflow-hidden bg-background">
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
            <ScrollAreaPrimitive.Content
              style={{ minWidth: 0 }}
              className={cn(
                "pt-bar",
                // Clear of the floating tab bar, or of the home indicator (0
                // off iOS).
                // The keyboard (--keyboard-h, unset elsewhere) hides the tab bar, so
                // it takes the bar's place: the last row scrolls above it.
                compact
                  ? "pb-[max(var(--tabs-float),var(--keyboard-h,0px))]"
                  : "pb-[max(env(safe-area-inset-bottom),var(--keyboard-h,0px))]",
              )}
            >
              {children}
            </ScrollAreaPrimitive.Content>
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar orientation="vertical" className="mt-[calc(var(--spacing-bar)+0.25rem)]" />
        </ScrollAreaPrimitive.Root>
      </main>
      {compact && !nativeTabs && <TabBar model={tabBar} />}
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
