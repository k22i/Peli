import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

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
  return (
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
}
