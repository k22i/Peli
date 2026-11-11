import { createFileRoute } from "@tanstack/react-router";

import { Components } from "@/components/gallery/components";
import { Foundations } from "@/components/gallery/foundations";
import { ThemeSwitcher } from "@/components/theme-switcher";

export const Route = createFileRoute("/gallery")({
  component: Gallery,
});

// The design system (#13) on one page: tokens, contrast and every component
// in its states. Linked from Settings, outside the six-item nav.
function Gallery() {
  return (
    <div className="flex flex-col gap-12 pb-16">
      <header className="flex flex-wrap items-end justify-between gap-4 px-page pt-8">
        <div className="flex flex-col gap-2">
          <p className="type-eyebrow text-sun-ink">Peli</p>
          <h1 className="type-display">Design system</h1>
          <p className="max-w-xl text-pretty text-muted-foreground">
            A screening room: warm dark surfaces, the system face for reading and a display serif
            for the big moments, and one ray of sunlight for what matters now. One theme, in light
            and dark.
          </p>
        </div>
        <ThemeSwitcher />
      </header>
      <Foundations />
      <Components />
    </div>
  );
}
