import { Window } from "@wailsio/runtime";

import { WindowControls } from "@/components/shell/window-controls";
import type { Platform } from "@/lib/platform";

// A drag strip across the top of the window where we draw the title bar:
// macOS (hidden-inset traffic lights sit on it) and frameless Windows. Linux
// keeps its native frame and gets none.
export function TitleBar({ platform }: { platform: Platform }) {
  if (platform !== "mac" && platform !== "windows") return null;

  return (
    <div
      data-slot="title-bar"
      className="drag-region col-span-full flex items-center justify-end data-[platform=mac]:h-11 data-[platform=windows]:h-8"
      data-platform={platform}
      // Native caption behaviour; macOS does this itself.
      onDoubleClick={(event) => {
        if (platform === "windows" && event.target === event.currentTarget) {
          void Window.ToggleMaximise();
        }
      }}
    >
      {platform === "windows" && <WindowControls />}
    </div>
  );
}
