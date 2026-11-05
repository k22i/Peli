import { useMatches, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

import { Sidebar } from "@/components/shell/sidebar";
import { TitleBar } from "@/components/shell/title-bar";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { currentPlatform } from "@/lib/platform";
import { searchFieldId } from "@/lib/search";
import { sections } from "@/sections";

// The window frame every route renders in: title bar, sidebar and a content
// pane that scrolls on its own. Only the content pane changes on navigation,
// so the shell never shifts. All backgrounds live here rather than on <body>,
// so a route with `staticData.chrome: "none"` gets a bare, transparent page.
export function AppShell({ children }: { children: ReactNode }) {
  const chrome = useMatches({
    select: (matches) => matches.findLast((match) => match.staticData.chrome)?.staticData.chrome,
  });
  const content = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const router = useRouter();
  const navigate = useNavigate();

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
      void navigate({ to });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, focusContentAfterNavigate]);

  if (chrome === "none") return children;

  const platform = currentPlatform();

  if (chrome === "focus") {
    return (
      <div className="grid h-svh grid-rows-[auto_1fr] bg-background text-foreground">
        <TitleBar platform={platform} />
        <main className="row-start-2 min-h-0 overflow-y-auto">{children}</main>
      </div>
    );
  }

  return (
    <div className="grid h-svh grid-cols-[auto_1fr] grid-rows-[auto_1fr] bg-sidebar text-foreground">
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
      <TitleBar platform={platform} />
      <Sidebar onKeyboardNavigate={focusContentAfterNavigate} />
      <main className="content-pane row-start-2 min-h-0 overflow-hidden bg-background md:rounded-tl-xl">
        {/* Overlay scrollbars, the same on every OS (WebView2 would draw
            classic ones), and never taking width from the page. */}
        <ScrollAreaPrimitive.Root className="size-full">
          <ScrollAreaPrimitive.Viewport
            ref={content}
            id="content"
            data-scroll-restoration-id="content"
            // Focusable for keyboard scrolling and for focus after navigation,
            // but not an extra Tab stop.
            tabIndex={-1}
            className="size-full outline-none"
          >
            {/* As coss's ScrollArea does: pages wrap to the pane's width. */}
            <ScrollAreaPrimitive.Content style={{ minWidth: 0 }}>
              {children}
            </ScrollAreaPrimitive.Content>
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar orientation="vertical" />
        </ScrollAreaPrimitive.Root>
      </main>
    </div>
  );
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
