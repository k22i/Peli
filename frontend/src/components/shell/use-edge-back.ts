import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  edgeDim,
  endEdgeBack,
  idleEdgeBack,
  moveEdgeBack,
  startEdgeBack,
  type EdgeBack,
} from "@/lib/edge-back";
import { sheetsOpen } from "@/lib/sheets";
import { springEasing } from "@/lib/sheet-drag";

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const shadow = "-10px 0 28px rgb(0 0 0 / 0.28)";

// Swipe from the left edge to go back, on iOS (#135; rules in
// lib/edge-back.ts). `page` is the shell's page layer (the <main> the route
// transitions animate) and `dim` the layer behind it. The page slides with
// the finger over a dimmed --background (no snapshot of the page before, so
// this is iOS's parallax stand-in); letting go past the threshold slides it
// off and goes back with the "back" transition (data-nav), otherwise it
// springs back. Off unless `enabled`: the shell passes false on the player,
// the focus screens and off iOS; an open sheet or no history turns it off
// for that touch.
export function useEdgeBack(page: HTMLElement | null, dim: HTMLElement | null, enabled: boolean) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled || !page || !dim) return undefined;
    let state: EdgeBack = idleEdgeBack;
    let offset = 0;
    let settling: number | undefined;

    const paint = (x: number, animate: "spring" | "out" | false) => {
      const width = window.innerWidth;
      const transition =
        animate === "spring"
          ? `translate 0.5s ${springEasing()}, box-shadow 0.5s ease-out`
          : animate === "out"
            ? "translate 0.2s ease-out"
            : "none";
      page.style.transition = transition;
      dim.style.transition =
        animate === "spring"
          ? "opacity 0.5s ease-out"
          : animate === "out"
            ? "opacity 0.2s ease-out"
            : "none";
      page.style.translate = x > 0 ? `${x}px 0` : "";
      page.style.boxShadow = x > 0 ? shadow : "";
      dim.style.opacity = String(x > 0 ? edgeDim(x, width) : 0);
      dim.style.visibility = x > 0 || animate ? "visible" : "hidden";
    };
    const reset = () => {
      page.style.transition = "";
      page.style.translate = "";
      page.style.boxShadow = "";
      dim.style.transition = "";
      dim.style.opacity = "0";
      dim.style.visibility = "hidden";
    };

    const goBack = () => {
      // The page stays off to the side until the router commits the page
      // before it, inside the view transition's update: the old snapshot
      // is the empty, dimmed space, and the new page enters with the
      // "back" animation (index.css).
      const off = router.subscribe("onLoad", () => {
        off();
        clearTimeout(fallback);
        reset();
      });
      const fallback = window.setTimeout(() => {
        off();
        reset();
      }, 1500);
      router.history.back();
    };

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || event.touches.length > 1 || settling !== undefined) {
        state = idleEdgeBack;
        return;
      }
      const allowed = sheetsOpen() === 0 && router.history.canGoBack();
      state = startEdgeBack(touch.clientX, touch.clientY, event.timeStamp, allowed);
      offset = 0;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || state.phase === "idle") return;
      const moved = moveEdgeBack(state, touch.clientX, touch.clientY, event.timeStamp);
      state = moved.state;
      if (!moved.claim) return;
      // The page stops scrolling, and a rail under the edge stops sliding.
      if (event.cancelable) event.preventDefault();
      offset = moved.offset;
      paint(offset, false);
    };
    const onEnd = (event: TouchEvent) => {
      // A cancelled touch (a call, a system gesture) never goes back.
      const ended = endEdgeBack(state, offset, window.innerWidth);
      const action = event.type === "touchcancel" && ended === "back" ? "cancel" : ended;
      state = idleEdgeBack;
      if (action === "none") return;
      if (action === "cancel") {
        paint(0, prefersReducedMotion() ? false : "spring");
        settling = window.setTimeout(() => {
          settling = undefined;
          reset();
        }, 500);
        return;
      }
      if (prefersReducedMotion()) {
        goBack();
        return;
      }
      paint(window.innerWidth, "out");
      settling = window.setTimeout(() => {
        settling = undefined;
        goBack();
      }, 200);
    };

    // Not passive: a claimed pan cancels the browser's own scrolling.
    document.addEventListener("touchstart", onStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onMove, { passive: false, capture: true });
    document.addEventListener("touchend", onEnd, { passive: true, capture: true });
    document.addEventListener("touchcancel", onEnd, { passive: true, capture: true });
    return () => {
      document.removeEventListener("touchstart", onStart, { capture: true });
      document.removeEventListener("touchmove", onMove, { capture: true });
      document.removeEventListener("touchend", onEnd, { capture: true });
      document.removeEventListener("touchcancel", onEnd, { capture: true });
      clearTimeout(settling);
      reset();
    };
  }, [enabled, page, dim, router]);
}
