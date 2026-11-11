import { Bookmark, BookmarkCheck, Star } from "lucide-react";

import { RoundAction } from "@/components/title/round-action";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { Meta } from "@/lib/addon-protocol";
import { ratingValues, titleRef, useTrackingControls } from "@/lib/tracking";
import type { Profile } from "@bindings/store";

// The title page's tracking actions, after Library and Watched: the
// watchlist toggle and a rating menu, as round glass buttons. Nothing on a
// kids profile or with SIMKL and AniList both unconnected.
export function TrackingActions({ profile, meta }: { profile: Profile; meta: Meta }) {
  const ref = titleRef(meta, meta.name, meta);
  const { available, statuses, state, setStatus, setRating } = useTrackingControls(
    profile,
    meta.type,
    ref,
  );
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
          onClick={() => setStatus.mutate(onWatchlist ? "none" : "planned")}
        >
          {onWatchlist ? <BookmarkCheck /> : <Bookmark />}
        </RoundAction>
      )}
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<Button variant="media" size="icon-xl" aria-label={ratingLabel} />}
              />
            }
          >
            <Star className={rating > 0 ? "fill-current" : undefined} />
          </TooltipTrigger>
          <TooltipPopup>{ratingLabel}</TooltipPopup>
        </Tooltip>
        <MenuPopup className="material-pop w-40" align="start">
          <MenuRadioGroup
            value={String(rating)}
            onValueChange={(next) => setRating.mutate(Number(next))}
          >
            {ratingValues.map((value) => (
              <MenuRadioItem key={value} value={String(value)}>
                {value}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {rating > 0 && (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => setRating.mutate(0)}>Clear rating</MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
    </>
  );
}
