import { Window } from "@wailsio/runtime";

import { WindowControls } from "@/components/shell/window-controls";
import type { Platform } from "@/lib/platform";
import { cn } from "@/lib/utils";

// A drag strip over the top of the window where we draw the title bar: macOS
// (hidden-inset traffic lights sit on it) and frameless Windows. Linux keeps
// its native frame and gets none. It floats over the content (#114): at rest
// it shows nothing, so a hero's art reaches the window's top edge, and once
// the page is scrolled it softens what passes under it with the scroll edge.
export function TitleBar({
  platform,
  scrolled = false,
}: {
  platform: Platform;
  scrolled?: boolean;
}) {
  if (platform !== "mac" && platform !== "windows") return null;

  return (
    <div
      data-slot="title-bar"
      data-platform={platform}
      data-scrolled={scrolled || undefined}
      className={cn(
        "drag-region fixed inset-x-0 top-0 z-20 flex h-(--titlebar-h) items-center justify-end",
        // The blur reaches over the strip itself, not only below it.
        "[--scroll-edge-cover:var(--titlebar-h)] not-data-scrolled:before:hidden scroll-edge-top",
      )}
      // Native caption behaviour; macOS does this itself.
      onDoubleClick={(event) => {
        if (platform === "windows" && event.target === event.currentTarget) {
          void Window.ToggleMaximise();
        }
      }}
    >
      {platform === "windows" && (
        // Glass, so the buttons read over artwork.
        <div className="relative me-1 h-7 overflow-hidden rounded-full glass-thin">
          <WindowControls />
        </div>
      )}
    </div>
  );
}
