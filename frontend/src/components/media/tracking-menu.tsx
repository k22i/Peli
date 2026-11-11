import { Bookmark, BookmarkCheck, ListChecks, Star } from "lucide-react";

import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import type { Meta } from "@/lib/addon-protocol";
import {
  ratingValues,
  titleRef,
  trackingStatusLabels,
  useTrackingControls,
  trackingStatusOf,
} from "@/lib/tracking";
import type { MenuTitle } from "@/lib/title-actions";
import type { Profile } from "@bindings/store";

// The Tracking group of a title's context menu: the watchlist, a list status
// and a rating, sent to SIMKL and AniList (whichever are connected). It
// renders nothing on a kids profile or with nothing connected, and offers
// only the statuses the connected services keep for the title.
export function TrackingMenu({
  title,
  meta,
  profile,
}: {
  title: MenuTitle;
  meta: Meta | undefined;
  profile: Profile;
}) {
  const ref = titleRef(title, title.name, meta);
  const { available, statuses, state, setStatus, setRating } = useTrackingControls(
    profile,
    title.type,
    ref,
  );
  if (!available) return null;

  const status = state?.status ?? "none";
  const rating = state?.rating ?? 0;
  const planned = statuses.includes("planned");
  // Planned is the watchlist's own item, so it's not in the Status submenu.
  const listStatuses = statuses.filter((option) => option !== "planned");

  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        {planned && (
          <ContextMenuItem
            onClick={() => setStatus.mutate(status === "planned" ? "none" : "planned")}
          >
            {status === "planned" ? <BookmarkCheck aria-hidden /> : <Bookmark aria-hidden />}
            {status === "planned" ? "Remove from Watchlist" : "Add to Watchlist"}
          </ContextMenuItem>
        )}
        {listStatuses.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <ListChecks aria-hidden />
              Status
            </ContextMenuSubTrigger>
            <ContextMenuSubPopup className="material-pop w-48">
              <ContextMenuRadioGroup
                value={status}
                onValueChange={(next) => {
                  const chosen = trackingStatusOf(next);
                  if (chosen) setStatus.mutate(chosen);
                }}
              >
                {listStatuses.map((option) => (
                  <ContextMenuRadioItem key={option} value={option}>
                    {option === "none" ? "None" : trackingStatusLabels[option]}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubPopup>
          </ContextMenuSub>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Star aria-hidden />
            Rate…
          </ContextMenuSubTrigger>
          <ContextMenuSubPopup className="material-pop w-40">
            <ContextMenuRadioGroup
              value={String(rating)}
              onValueChange={(next) => setRating.mutate(Number(next))}
            >
              {ratingValues.map((value) => (
                <ContextMenuRadioItem key={value} value={String(value)}>
                  {value}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
            {rating > 0 && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => setRating.mutate(0)}>Clear rating</ContextMenuItem>
              </>
            )}
          </ContextMenuSubPopup>
        </ContextMenuSub>
      </ContextMenuGroup>
    </>
  );
}
