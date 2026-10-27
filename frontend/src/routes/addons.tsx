import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { addonsQuery, manifestQuery } from "@/lib/addons";
import { currentProfileQuery } from "@/lib/profile";
import type { Addon, Profile } from "@bindings/store";

// Reached from the profile menu and Settings.
export const Route = createFileRoute("/addons")({
  component: Addons,
});

// The profile's installed addons, in order: for a Nuvio profile the same list
// Nuvio shows on the phone and TV, kept in sync by Go (#32). An addon whose
// manifest doesn't load keeps its place and says why. Installing,
// configuring, reordering and removing are the addon manager's (#38), which
// builds on this list and useEditAddons.
function Addons() {
  const profile = useQuery(currentProfileQuery).data;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-gutter py-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-title font-stretch-semi-expanded">Addons</h1>
        {profile && <p className="text-sm text-muted-foreground">{syncNote(profile)}</p>}
      </header>
      {profile ? <AddonList profileId={profile.id} /> : <Skeleton className="h-40 rounded-xl" />}
    </div>
  );
}

function syncNote(profile: Profile): string {
  if (profile.nuvioIndex === undefined || profile.nuvioIndex === null) {
    return "On this computer only.";
  }
  return profile.usesPrimaryAddons
    ? "Shared with your first Nuvio profile, and the same on every device."
    : "The same on every device signed in to Nuvio.";
}

function AddonList({ profileId }: { profileId: number }) {
  const addons = useQuery(addonsQuery(profileId));
  if (addons.isPending) return <Skeleton className="h-40 rounded-xl" />;
  if (addons.isError) {
    return <p className="text-sm text-destructive-foreground">The addons could not be read.</p>;
  }
  const list = addons.data ?? [];
  if (list.length === 0) {
    return <p className="text-sm text-muted-foreground">No addons installed.</p>;
  }
  return (
    <ul aria-label="Installed addons" className="flex flex-col divide-y rounded-xl border bg-card">
      {list.map((addon) => (
        <AddonRow key={addon.url} addon={addon} />
      ))}
    </ul>
  );
}

function AddonRow({ addon }: { addon: Addon }) {
  const manifest = useQuery(manifestQuery(addon.url));
  const name = addon.name || manifest.data?.name || addon.url;
  return (
    <li aria-label={name} className="flex items-start gap-3 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {manifest.data && (
            <span className="font-mono text-meta text-muted-foreground">
              v{manifest.data.version}
            </span>
          )}
          {!addon.enabled && <Badge variant="secondary">Off</Badge>}
        </div>
        <span className="truncate font-mono text-meta text-muted-foreground">{addon.url}</span>
        {manifest.isError && (
          <p className="mt-1 flex items-start gap-1.5 text-sm text-destructive-foreground">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              Couldn’t load its manifest. {manifest.error.message} It stays installed, here and on
              your other devices.
            </span>
          </p>
        )}
      </div>
      {manifest.isPending && <Spinner className="mt-0.5 size-4 text-muted-foreground" />}
    </li>
  );
}
