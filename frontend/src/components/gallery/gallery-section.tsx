import type { ReactNode } from "react";

export function GallerySection({
  title,
  description,
  bleed = false,
  children,
}: {
  title: string;
  description?: string;
  // Edge to edge, for rows and the hero, which bring their own gutter.
  bleed?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex max-w-2xl flex-col gap-1.5 px-gutter">
        <h2 className="font-heading text-title font-stretch-semi-expanded">{title}</h2>
        {description && <p className="text-pretty text-muted-foreground">{description}</p>}
      </div>
      {bleed ? children : <div className="flex flex-col gap-6 px-gutter">{children}</div>}
    </section>
  );
}

// A labelled specimen inside a section.
export function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-mono text-meta text-muted-foreground">{label}</h3>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
