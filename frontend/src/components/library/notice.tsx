import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { GridSkeleton } from "@/components/browse/browse-page";
import { DensePosterSkeleton } from "@/components/media/cards";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useCompactShell } from "@/lib/shell-mode";

// The Library page's empty and error states (#118): Browse's Notice with a
// larger icon (size-16) for a page that is otherwise all artwork. The action
// is a solid button, so pass `buttonVariants()` with no variant.
export function LibraryNotice({
  title,
  description,
  action,
  icon: Icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon: LucideIcon;
}) {
  // On an iPhone (#132) it sits in the middle of what is left between the
  // compact header (about 11rem) and the floating tab bar.
  const compact = useCompactShell();
  const notice = (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="size-16 [&_svg:not([class*='size-'])]:size-8">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h2>{title}</h2>
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
  return compact ? (
    <div
      data-slot="library-notice-compact"
      className="flex min-h-[calc(100dvh-var(--spacing-bar)-var(--tabs-float)-11rem)] items-center justify-center px-page"
    >
      {notice}
    </div>
  ) : (
    notice
  );
}

// The titles' and the watchlist's placeholder: Browse's grid, or on an
// iPhone (#132) the dense grid's columns (--poster-dense-columns) with 8 pt
// gaps.
export function LibraryGridSkeleton() {
  const compact = useCompactShell();
  if (!compact) return <GridSkeleton />;
  return (
    <div
      aria-hidden
      className="grid grid-cols-[repeat(var(--poster-dense-columns,3),minmax(0,1fr))] gap-x-2 gap-y-3.5 px-page"
    >
      {Array.from({ length: 18 }, (_, index) => (
        <DensePosterSkeleton key={index} />
      ))}
    </div>
  );
}
