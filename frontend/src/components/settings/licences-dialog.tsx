import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { noticesQuery } from "@/lib/licences";
import type { Component } from "@bindings/licences";

const kindLabel: Record<string, string> = {
  native: "Playback engine",
  go: "Go",
  npm: "Interface",
};

// Sinag's own licence and the notices of everything it includes (#18). The
// same text ships as THIRD_PARTY_NOTICES.md in every release.
export function LicencesDialog({ labelledBy }: { labelledBy: string }) {
  return (
    <Dialog>
      <DialogTrigger aria-labelledby={labelledBy} render={<Button variant="outline" size="sm" />}>
        View
      </DialogTrigger>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Licences</DialogTitle>
          <DialogDescription>
            Sinag is free software under the MIT licence. It includes the open-source software
            below.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Notices />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function Notices() {
  const notices = useQuery(noticesQuery);

  if (notices.isPending) return <Skeleton className="h-40 w-full" />;
  if (notices.isError) {
    return <p className="text-sm text-destructive-foreground">The licences could not be loaded.</p>;
  }

  const { app, components } = notices.data;
  return (
    <div className="flex flex-col gap-2">
      <Entry component={app} title="Sinag" meta="MIT" open />
      {(components ?? []).map((c) => (
        <Entry
          key={`${c.kind}/${c.name}@${c.version}`}
          component={c}
          title={c.version ? `${c.name} ${c.version}` : c.name}
          meta={`${c.licence} · ${kindLabel[c.kind] ?? c.kind}`}
        />
      ))}
    </div>
  );
}

function Entry({
  component,
  title,
  meta,
  open,
}: {
  component: Component;
  title: string;
  meta: string;
  open?: boolean;
}) {
  return (
    <details open={open} className="group rounded-lg border">
      <summary className="flex cursor-pointer items-baseline justify-between gap-4 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 truncate font-medium">{title}</span>
        <span className="shrink-0 text-caption text-muted-foreground">{meta}</span>
      </summary>
      <pre className="overflow-x-auto border-t px-3 py-2 font-mono text-meta whitespace-pre-wrap text-muted-foreground">
        {component.text}
      </pre>
    </details>
  );
}
