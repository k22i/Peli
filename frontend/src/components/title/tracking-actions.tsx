import { Bookmark, BookmarkCheck, Star } from "lucide-react";
import { useState } from "react";

import { RemoveTrackingDialog } from "@/components/media/remove-tracking-dialog";
import { RoundAction } from "@/components/title/round-action";
import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuItem,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuSeparator,
} from "@/components/ui/responsive-menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { Meta } from "@/lib/addon-protocol";
import { ratingValues, titleRef, useTrackingControls } from "@/lib/tracking";
import type { Profile } from "@bindings/store";

// The title page's tracking actions, after Library and Watched: the
// watchlist toggle and a rating menu, as round glass buttons. Nothing on a
// kids profile or with SIMKL and AniList both unconnected.
export function TrackingActions({ profile, meta }: { profile: Profile; meta: Meta }) {
  const ref = titleRef(meta, meta.name, meta);
  const { available, statuses, state, setStatus, setRating, warnsOnRemoval } = useTrackingControls(
    profile,
    meta.type,
    ref,
  );
  const [confirming, setConfirming] = useState(false);
  if (!available) return null;
  const rating = state?.rating ?? 0;
  const ratingLabel = rating > 0 ? `Your rating: ${rating}` : "Rate";
  const onWatchlist = state?.status === "planned";

  return (
    <>
      {statuses.includes("planned") && (
        <RoundAction
          label={onWatchlist ? "On watchlist" : "Add to watchlist"}
          disabled={setStatus.isPending}
          onClick={() => {
            if (!onWatchlist) setStatus.mutate("planned");
            // Off the watchlist may clear SIMKL's watch history: confirm.
            else if (warnsOnRemoval) setConfirming(true);
            else setStatus.mutate("none");
          }}
        >
          {onWatchlist ? <BookmarkCheck /> : <Bookmark />}
        </RoundAction>
      )}
      <RemoveTrackingDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => setStatus.mutate("none")}
      />
      <Tooltip>
        <ResponsiveMenu
          label="Rating"
          popupClassName="material-pop w-40"
          align="start"
          trigger={{
            render: (
              <TooltipTrigger
                render={<Button variant="media" size="icon-xl" aria-label={ratingLabel} />}
              />
            ),
            children: <Star className={rating > 0 ? "fill-current" : undefined} />,
          }}
        >
          <ResponsiveMenuRadioGroup
            value={String(rating)}
            onValueChange={(next) => setRating.mutate(Number(next))}
          >
            {ratingValues.map((value) => (
              <ResponsiveMenuRadioItem key={value} value={String(value)}>
                {value}
              </ResponsiveMenuRadioItem>
            ))}
          </ResponsiveMenuRadioGroup>
          {rating > 0 && (
            <>
              <ResponsiveMenuSeparator />
              <ResponsiveMenuItem onClick={() => setRating.mutate(0)}>
                Clear rating
              </ResponsiveMenuItem>
            </>
          )}
        </ResponsiveMenu>
        <TooltipPopup>{ratingLabel}</TooltipPopup>
      </Tooltip>
    </>
  );
}
