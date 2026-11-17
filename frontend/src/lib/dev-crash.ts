import { Service as Diagnostics } from "@bindings/diagnostics";

// The rig's crash commands (#127), for a build with the pelidev tag only
// (Diagnostics.Info().dev): Settings › About lists them on a device, and
// in the simulator cmd.js calls window.peliDev.<name>(). Each one checks one
// path of the crash diagnostics.

// Rejects a promise nobody handles: window's unhandledrejection.
export function rejectAPromise() {
  void Promise.reject(new Error("pelidev: an unhandled rejection, on purpose"));
}

// Throws from a timer: window's error event.
export function throwUncaught() {
  setTimeout(() => {
    throw new Error("pelidev: an uncaught error, on purpose");
  }, 0);
}

// Grows the content process until iOS kills it: canvases (WebKit may cap
// their memory, so plain buffers too), touched so the pages are really
// used. The native shell then reloads the page (the loop guard decides how).
export function allocateUntilKilled() {
  const hog: unknown[] = [];
  window.peliHog = hog;
  const step = () => {
    for (let i = 0; i < 2; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 4096;
      canvas.height = 4096;
      canvas.getContext("2d")?.fillRect(0, 0, 4096, 4096);
      hog.push(canvas);
      hog.push(new Uint8Array(32 * 1024 * 1024).fill(i + 1));
    }
    setTimeout(step, 30);
  };
  step();
}

// A goroutine panics: the app ends and leaves a crash file.
export const panicInGo = () => Diagnostics.DevCrash("panic");
// The same through safego: logged, and the app goes on.
export const recoveredPanicInGo = () => Diagnostics.DevCrash("panic-recovered");
// What a memory warning from iOS does.
export const memoryWarning = () => Diagnostics.DevCrash("memory-warning");

export type DevCrash = {
  // Throwing in render needs React: the page sets state that renders a
  // component that throws (Settings' crash rows register it).
  throwInRender?: () => void;
  rejectAPromise: () => void;
  throwUncaught: () => void;
  allocateUntilKilled: () => void;
  panicInGo: () => Promise<void>;
  recoveredPanicInGo: () => Promise<void>;
  memoryWarning: () => Promise<void>;
};

// window.peliDev for the simulator's cmd.js.
export function installDevCrash(): DevCrash {
  const dev: DevCrash = {
    rejectAPromise,
    throwUncaught,
    allocateUntilKilled,
    panicInGo,
    recoveredPanicInGo,
    memoryWarning,
  };
  window.peliDev = dev;
  return dev;
}

declare global {
  interface Window {
    peliDev?: DevCrash;
    peliHog?: unknown[];
  }
}
