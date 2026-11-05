import { useQuery } from "@tanstack/react-query";
import { Baby } from "lucide-react";
import { useId } from "react";

import type { Profile } from "@bindings/store";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { addonsQuery } from "@/lib/addons";
import { kidsScopeQuery, profileProblem, useSetKids, useSetKidsScope } from "@/lib/account";

// Makes a Nuvio profile a kids profile and chooses what it sees (#26): the
// addons its catalogs and search results come from. It sits in the profile
// editor, which a kids profile only opens with its parent PIN. Both changes
// save at once, on this computer only: Nuvio has no kids profiles.
export function KidsSection({ profile }: { profile: Profile }) {
  const headingId = useId();
  const setKids = useSetKids();
  const kids = profile.kids === true;
  const needsPin = !kids && profile.pinEnabled !== true;

  const toggle = (on: boolean) =>
    setKids.mutate(
      { profileId: profile.id, kids: on },
      { onError: (error) => toastManager.add({ type: "error", ...profileProblem(error) }) },
    );

  return (
    <section className="flex flex-col gap-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="flex items-center gap-2 text-card">
        <Baby className="size-4" aria-hidden />
        Kids profile
      </h3>
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col">
          <span id={`${headingId}-label`} className="text-body">
            Only show what I choose
          </span>
          <span id={`${headingId}-description`} className="text-caption text-muted-foreground">
            {needsPin
              ? "Set a PIN first. It becomes the parent PIN that leaves this profile."
              : "Leaving this profile, and changing it, asks for its PIN."}
          </span>
        </span>
        <Switch
          aria-labelledby={`${headingId}-label`}
          aria-describedby={`${headingId}-description`}
          checked={kids}
          disabled={needsPin || setKids.isPending}
          onCheckedChange={toggle}
        />
      </div>
      {kids && <AllowedAddons profileId={profile.id} />}
    </section>
  );
}

// The profile's addons, each on or off for a kids profile. What isn't on is
// hidden, including addons installed later.
function AllowedAddons({ profileId }: { profileId: number }) {
  const addons = useQuery(addonsQuery(profileId));
  const scope = useQuery(kidsScopeQuery(profileId));
  const save = useSetKidsScope(profileId);
  const labelId = useId();

  if (addons.isPending || scope.isPending) return <Skeleton className="h-16 rounded-xl" />;
  const list = addons.data ?? [];
  const allowed = scope.data?.addons ?? [];
  if (list.length === 0) {
    return (
      <p className="text-body text-muted-foreground">
        This profile has no addons yet, so it shows nothing. Install some, then come back and choose
        which ones it can see.
      </p>
    );
  }

  const change = (url: string, on: boolean) => {
    const addonsNow = on ? [...allowed, url] : allowed.filter((a) => a !== url);
    save.mutate(
      {
        addons: addonsNow,
        // A catalog only counts with its addon.
        catalogs: (scope.data?.catalogs ?? []).filter((c) => addonsNow.includes(c.addon)),
      },
      { onError: (error) => toastManager.add({ type: "error", ...profileProblem(error) }) },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <p id={labelId} className="text-body text-muted-foreground">
        This profile’s catalogs and search show only these addons.
        {allowed.length === 0 && " None is chosen yet, so it shows nothing."}
      </p>
      <ul aria-labelledby={labelId} className="flex flex-col divide-y rounded-xl border">
        {list.map((addon) => (
          <li key={addon.url}>
            <label className="flex items-center justify-between gap-4 px-3 py-2.5">
              <span className="min-w-0 truncate text-body">
                {addon.name || addon.url}
                {!addon.enabled && <span className="text-muted-foreground"> (off)</span>}
              </span>
              <Switch
                aria-label={addon.name || addon.url}
                checked={allowed.includes(addon.url)}
                onCheckedChange={(on) => change(addon.url, on)}
              />
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
