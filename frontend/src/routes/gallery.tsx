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
    <div className="flex flex-col gap-section pb-section">
      <header className="flex flex-wrap items-end justify-between gap-4 px-gutter pt-8">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-meta tracking-widest text-brand uppercase">Cove</p>
          <h1 className="font-heading text-display font-stretch-expanded">Design system</h1>
          <p className="max-w-xl text-pretty text-muted-foreground">
            Apple’s glass and motion, Vercel’s monochrome precision, Nuvio’s cinema. One theme, in
            light and dark.
          </p>
        </div>
        <ThemeSwitcher />
      </header>
      <Foundations />
      <Components />
    </div>
  );
}
