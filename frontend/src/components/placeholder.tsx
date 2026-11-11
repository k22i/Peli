import type { ReactNode } from "react";

// Stand-in page body until each section is built.
export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="grid place-items-center gap-3 p-8">
      <h1 className="type-title">{title}</h1>
      {children}
    </section>
  );
}
