import { useSyncExternalStore } from "react";

// The downloads tray (#85 follow-up): the shell's download button opens it
// (a popover from the top bar on the desktop and the iPad, a bottom sheet on
// the iPhone), and anything else may open it too, such as the toast that
// says a download started. One open flag for the whole app.
let open = false;
const listeners = new Set<() => void>();

export function setDownloadTrayOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const openDownloadTray = (): void => setDownloadTrayOpen(true);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDownloadTrayOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}
