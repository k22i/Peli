import { Call } from "@wailsio/runtime";

// Every mark is an absolute epoch time in ms (timeOrigin + performance.now()),
// so the launcher can line it up with its own spawn time and Go's marks.
const marks: Record<string, number | string | boolean | null> = {};
const now = () => performance.timeOrigin + performance.now();

export const call = (method: string, ...args: unknown[]) => Call.ByName(`main.Probe.${method}`, ...args);

export function scriptStart() {
  marks.timeOrigin = performance.timeOrigin;
  marks.scriptStart = now();
}

function navMarks() {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!nav) return;
  marks.responseEnd = performance.timeOrigin + nav.responseEnd;
  marks.domContentLoaded = performance.timeOrigin + nav.domContentLoadedEventEnd;
}

function paintEntries(): Promise<void> {
  // First (contentful) paint, where the engine supports Paint Timing.
  return new Promise((resolve) => {
    const take = () => {
      for (const e of performance.getEntriesByType("paint")) {
        marks[e.name === "first-contentful-paint" ? "fcp" : "firstPaint"] = performance.timeOrigin + e.startTime;
      }
    };
    take();
    if (marks.fcp) return resolve();
    try {
      const obs = new PerformanceObserver(() => take());
      obs.observe({ type: "paint", buffered: true });
      setTimeout(() => {
        obs.disconnect();
        take();
        resolve();
      }, 500);
    } catch {
      resolve();
    }
  });
}

// Called from the shell's first effect: the frame after React's first commit
// has been produced once a rAF callback ran and a task after it ran.
export function shellMounted() {
  marks.mounted = now();
  requestAnimationFrame(() => {
    marks.raf = now();
    setTimeout(async () => {
      marks.painted = now();
      marks.visibility = document.visibilityState;
      marks.focused = document.hasFocus();
      navMarks();
      await paintEntries();
      marks.fcpSupported = PerformanceObserver.supportedEntryTypes?.includes("paint") ?? false;
      marks.userAgent = navigator.userAgent;
      marks.devicePixelRatio = window.devicePixelRatio;
      marks.jsHeap = (performance as any).memory?.usedJSHeapSize ?? null;
      await call("Report", marks);
    }, 0);
  });
}

export function late(extra: Record<string, unknown>) {
  return call("Late", { ...extra, at: now() });
}
