import type { ReactNode } from "react";

// Stand-in page body until each section is built.
export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="grid place-items-center gap-2 p-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </section>
  );
}
