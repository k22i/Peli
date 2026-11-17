import { Bookmark, BookmarkCheck, ListChecks, Star } from "lucide-react";

import {
  ResponsiveMenuGroup,
  ResponsiveMenuItem,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuSeparator,
  ResponsiveMenuSub,
} from "@/components/ui/responsive-menu";
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
  confirm,
}: {
  title: MenuTitle;
  meta: Meta | undefined;
  profile: Profile;
  confirm: (run: () => void) => void;
}) {
  const ref = titleRef(title, title.name, meta);
  const { available, statuses, state, setStatus, setRating, warnsOnRemoval } = useTrackingControls(
    profile,
    title.type,
    ref,
  );
  if (!available) return null;

  // Taking a title off the lists may clear SIMKL's watch history: confirm.
  const remove = () =>
    warnsOnRemoval ? confirm(() => setStatus.mutate("none")) : setStatus.mutate("none");
  const status = state?.status ?? "none";
  const rating = state?.rating ?? 0;
  const planned = statuses.includes("planned");
  // Planned is the watchlist's own item, so it's not in the Status submenu.
  const listStatuses = statuses.filter((option) => option !== "planned");

  return (
    <>
      <ResponsiveMenuSeparator />
      <ResponsiveMenuGroup>
        {planned && (
          <ResponsiveMenuItem
            onClick={() => (status === "planned" ? remove() : setStatus.mutate("planned"))}
          >
            {status === "planned" ? <BookmarkCheck aria-hidden /> : <Bookmark aria-hidden />}
            {status === "planned" ? "Remove from Watchlist" : "Add to Watchlist"}
          </ResponsiveMenuItem>
        )}
        {listStatuses.length > 0 && (
          <ResponsiveMenuSub
            title="Status"
            popupClassName="material-pop w-48"
            label={
              <>
                <ListChecks aria-hidden />
                Status
              </>
            }
          >
            <ResponsiveMenuRadioGroup
              value={status}
              onValueChange={(next) => {
                const chosen = trackingStatusOf(next);
                if (chosen === "none") remove();
                else if (chosen) setStatus.mutate(chosen);
              }}
            >
              {listStatuses.map((option) => (
                <ResponsiveMenuRadioItem key={option} value={option}>
                  {option === "none" ? "None" : trackingStatusLabels[option]}
                </ResponsiveMenuRadioItem>
              ))}
            </ResponsiveMenuRadioGroup>
          </ResponsiveMenuSub>
        )}
        <ResponsiveMenuSub
          title="Rating"
          popupClassName="material-pop w-40"
          label={
            <>
              <Star aria-hidden />
              Rate…
            </>
          }
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
        </ResponsiveMenuSub>
      </ResponsiveMenuGroup>
    </>
  );
}
