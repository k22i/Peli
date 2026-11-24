import { ImageOffIcon, Loader2Icon } from "lucide-react";

import type { PreviewImage } from "@/lib/previews";
import { cn } from "@/lib/utils";

// A seek preview as the seek bar's bubble and the touch scrub label show it:
// the thumbnail, a neighbouring bucket's dimmed while the right one loads,
// or, before any is made near the time, a placeholder of the thumbnail's
// shape. Over it, what's happening: a spinner while Go is still making the
// right one (half a second or more on a remux), so it reads as coming, not
// missing; or "No preview" when it can't be made (the debrid server pushed
// back, or the decoder failed), so it doesn't spin forever. `className`
// sizes and rounds it.
export function PreviewFrame({
  preview,
  className,
  testId,
}: {
  preview: PreviewImage;
  className: string;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      data-exact={preview.exact || undefined}
      data-state={preview.failed ? "failed" : preview.loading ? "loading" : "ready"}
      style={{ aspectRatio: `${preview.w} / ${preview.h}` }}
      className={cn("relative overflow-hidden bg-white/8", className)}
    >
      {preview.url !== undefined && (
        <img
          src={preview.url}
          alt=""
          width={preview.w}
          height={preview.h}
          className={cn("size-full object-cover", !preview.exact && "opacity-60")}
        />
      )}
      {preview.failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40 text-white/80">
          <ImageOffIcon aria-hidden className="size-5" />
          <span className="text-[0.6875rem] font-semibold">No preview</span>
        </div>
      ) : (
        preview.loading && (
          <div className="absolute inset-0 grid place-items-center">
            <Loader2Icon aria-hidden className="size-5 animate-spin text-white/80" />
          </div>
        )
      )}
    </div>
  );
}
