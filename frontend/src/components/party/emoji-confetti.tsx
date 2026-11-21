import { useEffect, useRef } from "react";

import { alpha, cap, spawn, spawnGentle, step, stepGentle, type Particle } from "@/lib/confetti";

// Between the player's own chrome and the app's popups: the player tops out at
// z-20 (stats-overlay z-10; picture-sheet, subtitle-panel, still-watching and
// the touch chrome's sheet z-20), while components/ui's menus, sheets, dialogs
// and the command palette are z-50 and toasts z-60. PartyReactionLayer renders
// this straight into the player's fixed inset-0 root, so it spans the whole
// player, a docked party panel and the dock included: it is inert, and the
// emoji are gone in 2.5 s, which is the trade for never covering a menu.
const layerZ = "z-30";

// How many emoji one reaction throws.
const perBurst = 40;

// Emoji come from the OS font stack, not the UI font.
const emojiFont = 'system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';

// The mounted layer, so `burst` can reach it without a ref or a context. The
// last layer mounted wins, and unmounting it leaves `burst` a no-op.
let mounted: ((emoji: string) => void) | null = null;

export function burst(emoji: string): void {
  mounted?.(emoji);
}

// One canvas across the player, driven by a single animation loop that runs only
// while there is something to draw.
export function EmojiConfetti() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    // jsdom, and a layer that never got laid out, has no 2d context: draw
    // nothing rather than throw.
    const context = element.getContext("2d");
    if (!context) return undefined;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduceMotion = motion.matches;
    const follow = (event: MediaQueryListEvent) => {
      reduceMotion = event.matches;
    };
    motion.addEventListener("change", follow);

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frame: number | null = null;
    let previous = 0;

    const repaint = (now: number) => {
      context.clearRect(0, 0, width, height);
      for (const particle of particles) {
        const fade = alpha(particle, now);
        if (fade <= 0) continue;
        context.save();
        context.globalAlpha = fade;
        context.translate(particle.x, particle.y);
        context.rotate(particle.rot);
        context.font = `${particle.size}px ${emojiFont}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(particle.emoji, 0, 0);
        context.restore();
      }
    };

    const animate = (now: number) => {
      frame = null;
      // A clamped step keeps a stall (a hidden window, a busy main thread) from
      // teleporting the confetti off the layer.
      const dt = previous === 0 ? 1 / 60 : Math.min((now - previous) / 1000, 0.05);
      previous = now;
      particles = reduceMotion ? stepGentle(particles, dt, now) : step(particles, dt, now);
      repaint(now);
      if (particles.length > 0) {
        frame = requestAnimationFrame(animate);
      } else {
        previous = 0;
      }
    };

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = element.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      // Backing store in device pixels, drawing in CSS pixels.
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      repaint(performance.now());
    };

    const spawnBurst = (emoji: string) => {
      if (width === 0 || height === 0) resize();
      if (width === 0 || height === 0) return;
      const now = performance.now();
      const fresh = reduceMotion
        ? spawnGentle(emoji, width, height, now)
        : spawn(emoji, perBurst, width, height, now);
      particles = cap([...particles, ...fresh]);
      if (frame === null) frame = requestAnimationFrame(animate);
    };

    resize();
    // jsdom has no ResizeObserver.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(element);
    mounted = spawnBurst;

    return () => {
      if (mounted === spawnBurst) mounted = null;
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      motion.removeEventListener("change", follow);
      particles = [];
    };
  }, []);

  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 ${layerZ}`}>
      <canvas ref={canvas} className="block size-full" />
    </div>
  );
}
