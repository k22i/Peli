import type { ReactNode } from "react";

export type SettingsSectionInfo = { id: string; title: string };

export const headingId = (sectionId: string) => `settings-${sectionId}`;

// One group of settings, Apple-style: a heading over rows in a rounded list.
export function SettingsSection({
  section,
  children,
}: {
  section: SettingsSectionInfo;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId(section.id)} className="flex scroll-mt-8 flex-col gap-3">
      {/* Focused by the section list, so it takes focus without a Tab stop. */}
      <h2
        id={headingId(section.id)}
        tabIndex={-1}
        className="font-heading text-heading font-stretch-semi-expanded outline-none"
      >
        {section.title}
      </h2>
      <div className="flex flex-col divide-y rounded-xl border bg-card">{children}</div>
    </section>
  );
}

// A setting: its label and what it does on the left, the control on the right.
// The control names itself with aria-labelledby={`${id}-label`} and
// aria-describedby={`${id}-description`}.
export function SettingRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <span id={`${id}-label`} className="text-sm font-medium">
          {label}
        </span>
        {description && (
          <p id={`${id}-description`} className="text-sm text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The settings' own table of contents. Buttons rather than links: the router
// uses the URL hash, so "#playback" would be read as a route.
export function SettingsNav({ sections }: { sections: readonly SettingsSectionInfo[] }) {
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-8 hidden w-44 shrink-0 self-start md:block"
    >
      <ul className="flex flex-col gap-0.5">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              className="w-full rounded-lg px-3 py-1.5 text-start text-sm text-muted-foreground transition-colors duration-(--duration-fast) ease-smooth outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                const heading = document.getElementById(headingId(section.id));
                heading?.focus({ preventScroll: true });
                heading?.scrollIntoView?.({
                  block: "start",
                  behavior: reducedMotion() ? "auto" : "smooth",
                });
              }}
            >
              {section.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
