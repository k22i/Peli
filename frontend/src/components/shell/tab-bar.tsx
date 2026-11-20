import { Link } from "@tanstack/react-router";
import { useEffect, useState, type MouseEvent } from "react";

import type { TabBarModel } from "@/components/shell/use-tab-bar";
import { primeKeyboard } from "@/lib/keyboard";
import { searchSection, tabSections } from "@/lib/tab-bar";
import { cn } from "@/lib/utils";
import type { Section } from "@/sections";

export { tabSections };

// The keyboard is up when the visual viewport is much shorter than the
// layout one (WebKit shrinks it for the on-screen keyboard). The native bar
// watches UIKeyboardWillShow itself.
function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () => setUp(window.innerHeight - viewport.height > 120);
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);
  return up;
}

// The glass of the capsule and the Search circle: the bar material with a
// specular top edge and a soft shadow, the CSS stand-in for Liquid Glass
// (ADR-0046) where the native bar isn't (iOS before 26, tests).
export const capsuleGlass =
  "material-bar border border-white/12 shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_-1px_0_rgb(0_0_0/0.06),0_8px_28px_rgb(0_0_0/0.18)] dark:border-white/10 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_8px_28px_rgb(0_0_0/0.5)]";

// The compact shell's navigation (iPhone, a narrow iPad window) when there
// is no native bar: a floating capsule of sections and a round Search button
// beside it, in the same geometry as internal/shell/tabbar_ios.m. 62 pt
// high, 16 pt in from the safe edges, its bottom just over the home
// indicator (--tabs-bottom); 52 pt with labels beside the icons, centred and
// at most 560 pt wide, on an iPhone on its side. Scrolling down shrinks the
// capsule to the current tab's icon; a tap brings it back.
// `centred` is the iPad's (#138, regular width without the sidebar): the
// same capsule, centred at the bottom and no wider than on a phone on its
// side, instead of spanning a wide screen. It never shrinks on scroll.
export function TabBar({ model, centred = false }: { model: TabBarModel; centred?: boolean }) {
  const keyboard = useKeyboardUp();
  const { active, minimized, select, expand } = model;
  const hidden = model.hidden || keyboard;
  const index = tabSections.findIndex((section) => section.to === active);
  const current = tabSections[index];
  // The iPad has the room: its bar keeps every section (the user, #138).
  const mini = minimized && !centred && current !== undefined;

  const onTap = (section: Section) => (event: MouseEvent) => {
    event.preventDefault();
    // Search opens with the keyboard up: focus has to start in this tap.
    if (section === searchSection) primeKeyboard();
    select(section);
  };

  return (
    <nav
      aria-label="Main"
      data-slot="tab-bar"
      data-minimized={mini || undefined}
      data-centred={centred || undefined}
      inert={hidden}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-(--tabs-bottom) z-30 flex h-(--tabs-h) gap-2 ps-[calc(env(safe-area-inset-left)+1rem)] pe-[calc(env(safe-area-inset-right)+1rem)] transition-[translate,opacity] duration-(--duration-base) ease-(--ease-out-soft) motion-reduce:transition-none ios-short:mx-auto ios-short:max-w-[calc(560px+2rem)]",
        centred && "mx-auto max-w-[calc(560px+2rem)]",
        hidden && "translate-y-[calc(100%+var(--tabs-bottom)+1.5rem)] opacity-0",
      )}
    >
      <div
        data-slot="tab-capsule"
        className={cn(
          capsuleGlass,
          "app-tab-capsule pointer-events-auto relative h-full rounded-full transition-[width,height,margin] duration-(--duration-base) ease-(--ease-out-soft) motion-reduce:transition-none",
          mini ? "my-[calc((var(--tabs-h)-48px)/2)] h-12 w-12 flex-none" : "min-w-0 flex-1",
        )}
      >
        {mini ? (
          <button
            type="button"
            onClick={expand}
            aria-label={current.label}
            aria-expanded={false}
            className="grid size-full place-items-center rounded-full text-sun-ink outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-6"
          >
            <current.icon aria-hidden strokeWidth={2} />
          </button>
        ) : (
          <ul className="relative flex h-full items-stretch p-1">
            {/* The selection: a lens behind the current tab that slides. */}
            {index >= 0 && (
              <li
                aria-hidden
                data-slot="tab-pill"
                className="pointer-events-none absolute inset-y-1 start-1 rounded-full bg-foreground/9 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] transition-transform duration-[350ms] ease-(--ease-out-soft) motion-reduce:transition-none"
                style={{
                  width: `calc((100% - 0.5rem) / ${tabSections.length})`,
                  transform: `translateX(${index * 100}%)`,
                }}
              />
            )}
            {tabSections.map((section) => {
              const selected = section.to === active;
              const Icon = section.icon;
              return (
                <li key={section.to} className="relative flex min-w-0 flex-1">
                  <Link
                    to={section.to}
                    onClick={onTap(section)}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[0.625rem] font-[590] tracking-[0.01em] outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring ios-short:flex-row ios-short:gap-1.5 ios-short:text-[0.75rem] [&_svg]:size-6",
                      selected ? "text-sun-ink" : "text-foreground/75",
                    )}
                  >
                    <Icon aria-hidden strokeWidth={2} />
                    <span className="max-w-full truncate">{section.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Link
        to={searchSection.to}
        onClick={onTap(searchSection)}
        aria-current={active === searchSection.to ? "page" : undefined}
        data-slot="tab-search"
        className={cn(
          capsuleGlass,
          "app-tab-search pointer-events-auto ms-auto grid h-full w-(--tabs-h) shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-6",
          active === searchSection.to ? "text-sun-ink" : "text-foreground/85",
        )}
      >
        <searchSection.icon aria-hidden strokeWidth={2} />
        <span className="sr-only">{searchSection.label}</span>
      </Link>
    </nav>
  );
}
