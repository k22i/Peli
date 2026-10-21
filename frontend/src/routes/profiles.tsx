import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Lock, Pencil, Plus } from "lucide-react";
import { useId, useState } from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import {
  DeleteProfileDialog,
  ProfileEditor,
  type EditorTarget,
} from "@/components/account/profile-editor";
import { parentSteps, pinSteps, usePinSteps } from "@/components/account/pin-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { maxNuvioProfiles, profilesQuery, useSwitchProfile } from "@/lib/account";
import { useCurrentProfile } from "@/lib/profile";
import type { Profile } from "@bindings/store";

type Search = { manage?: boolean };

export const Route = createFileRoute("/profiles")({
  staticData: { chrome: "focus" },
  // Settings › Profiles › Manage opens it ready to edit (#95).
  validateSearch: (search: Record<string, unknown>): Search =>
    search["manage"] === true ? { manage: true } : {},
  component: Profiles,
});

const linked = (p: Profile) => p.nuvioIndex !== undefined && p.nuvioIndex !== null;

// Who's watching (#24): shown at launch and after signing in when there's
// more than one profile, and from the profile menu and Settings. Its Manage
// mode adds, edits and deletes profiles (#95).
function Profiles() {
  const navigate = useNavigate();
  const router = useRouter();
  const search = Route.useSearch();
  const profiles = useQuery(profilesQuery);
  const current = useCurrentProfile();
  const switchProfile = useSwitchProfile();
  const [managing, setManaging] = useState(search.manage === true);
  const [editing, setEditing] = useState<EditorTarget>();
  const [removing, setRemoving] = useState<Profile>();
  // Runs an action once the PINs are in: a locked profile's own (#25), and
  // the parent PIN to leave or change a kids profile (#26).
  const { ask, dialog: pinDialog } = usePinSteps();
  // Changes that aren't about one profile, such as adding one, can't be made
  // from a kids profile without its parent PIN.
  const askParent = (run: () => void) => ask(parentSteps(current), run);

  const enter = (profile: Profile) => {
    if (profile.id === current.id && !profile.pinEnabled) {
      void navigate({ to: "/" });
      return;
    }
    switchProfile.mutate(profile, {
      onSuccess: () => void navigate({ to: "/" }),
      onError: () => {
        toastManager.add({ type: "error", title: `Couldn’t switch to ${profile.name}` });
      },
    });
  };
  const pick = (profile: Profile) => {
    if (managing) ask(pinSteps(current, profile, "edit"), () => setEditing({ profile }));
    else ask(pinSteps(current, profile, "switch"), () => enter(profile));
  };

  const list = profiles.data ?? [];
  // Tiles wait for the current profile too, so the last one used can take
  // focus as they mount.
  const ready = profiles.data !== undefined && current.id !== undefined;
  const guest = list.find((p) => p.guest);
  // The Guest can go once there's another profile to land on.
  const removableGuest = guest && list.length > 1 ? guest : undefined;
  // At launch there's nothing to go back to: picking is the way in.
  const canGoBack = router.history.canGoBack();
  const account = current.signedIn || current.sessionEnded;
  const nuvioProfiles = list.filter(linked);
  const full = nuvioProfiles.length >= maxNuvioProfiles;
  // Nuvio's own apps keep the primary profile, and every account has one.
  const deletable = (p: Profile) =>
    p.guest ? removableGuest === p : linked(p) && p.nuvioIndex !== 1 && nuvioProfiles.length > 1;
  // Nuvio profiles change in Nuvio, so they wait for a session (#95).
  const editable = (p: Profile) => !linked(p) || current.signedIn;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-10 px-6 py-12">
      {canGoBack && (
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2.5 self-start"
          onClick={() => router.history.back()}
        >
          <ArrowLeft />
          Back
        </Button>
      )}

      <h1 className="text-center font-heading text-title font-stretch-semi-expanded">
        {managing ? "Manage profiles" : "Who’s watching?"}
      </h1>

      <ul aria-label="Profiles" className="flex flex-wrap justify-center gap-x-6 gap-y-8">
        {!ready &&
          [0, 1].map((i) => (
            <li key={i}>
              <Skeleton className="size-24 rounded-full md:size-28" />
            </li>
          ))}
        {ready &&
          list.map((profile) => (
            <li key={profile.id}>
              <ProfileTile
                profile={profile}
                current={profile.id === current.id}
                managing={managing}
                disabled={switchProfile.isPending || (managing && !editable(profile))}
                onPick={() => pick(profile)}
              />
            </li>
          ))}
        {ready && managing && current.signedIn && !full && (
          <li>
            <button
              type="button"
              onClick={() => askParent(() => setEditing({ add: true }))}
              className="group flex w-28 flex-col items-center gap-3 rounded-2xl p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-32"
            >
              <span className="flex size-24 items-center justify-center rounded-full border-2 border-dashed border-foreground/24 text-muted-foreground transition-[border-color,scale] group-hover:border-foreground/48 group-active:scale-96 md:size-28">
                <Plus className="size-8" />
              </span>
              <span className="min-h-8 text-sm font-medium">Add profile</span>
            </button>
          </li>
        )}
      </ul>

      <footer className="flex flex-col items-center gap-4 text-center">
        {managing ? (
          <>
            {current.sessionEnded && (
              <p className="max-w-sm text-sm text-balance text-muted-foreground">
                Your Nuvio session ended. Sign in again to change your Nuvio profiles; they change
                on every device.
              </p>
            )}
            {current.signedIn && full && (
              <p className="max-w-sm text-sm text-balance text-muted-foreground">
                All {maxNuvioProfiles} Nuvio profiles are in use. Delete one to add another.
              </p>
            )}
            <Button onClick={() => setManaging(false)}>Done</Button>
          </>
        ) : (
          <>
            {!account && (
              <Link to="/sign-in" className={buttonVariants({ variant: "outline" })}>
                Sign in to bring your Nuvio profiles
              </Link>
            )}
            {ready && (
              <Button variant="outline" onClick={() => setManaging(true)}>
                <Pencil />
                Manage profiles
              </Button>
            )}
            {removableGuest && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => askParent(() => setRemoving(removableGuest))}
              >
                Remove the Guest profile
              </Button>
            )}
          </>
        )}
      </footer>

      <ProfileEditor
        target={editing}
        deletable={editing !== undefined && "profile" in editing && deletable(editing.profile)}
        onClose={() => setEditing(undefined)}
      />
      <DeleteProfileDialog profile={removing} onClose={() => setRemoving(undefined)} />
      {pinDialog}
    </div>
  );
}

// One profile: its avatar and name, read out as the name with a note. In
// Manage mode it opens the editor.
function ProfileTile({
  profile,
  current,
  managing,
  disabled,
  onPick,
}: {
  profile: Profile;
  current: boolean;
  managing: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const noteId = useId();
  const note =
    profile.kids && !current ? (
      <span className="inline-flex items-center gap-1">
        <Lock className="size-3" aria-hidden />
        Kids
      </span>
    ) : profile.pinEnabled && !current ? (
      <span className="inline-flex items-center gap-1">
        <Lock className="size-3" aria-hidden />
        PIN
      </span>
    ) : profile.guest ? (
      "On this computer"
    ) : current ? (
      "Last used"
    ) : undefined;
  return (
    <button
      type="button"
      // The last-used profile is a press of Return away.
      // oxlint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={current && !managing}
      aria-current={current ? "true" : undefined}
      aria-label={managing ? `Edit ${profile.name}` : profile.name}
      aria-describedby={note ? noteId : undefined}
      disabled={disabled}
      onClick={onPick}
      className="group flex w-28 flex-col items-center gap-3 rounded-2xl p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64 md:w-32"
    >
      <span className="relative">
        <ProfileAvatar
          profile={profile}
          className="size-24 text-2xl ring-offset-2 ring-offset-background transition-[box-shadow,scale] group-hover:ring-2 group-hover:ring-foreground/24 group-active:scale-96 group-aria-current:ring-2 group-aria-current:ring-primary md:size-28"
        />
        {managing && (
          <span className="absolute end-0 bottom-0 flex size-9 items-center justify-center rounded-full border-3 border-background bg-foreground text-background transition-scale group-active:scale-96">
            <Pencil className="size-4" />
          </span>
        )}
      </span>
      <span className="flex max-w-full flex-col">
        <span className="truncate text-sm font-medium">{profile.name}</span>
        {/* Kept when empty, so names line up. */}
        <span id={noteId} className="min-h-4 text-xs text-muted-foreground">
          {note}
        </span>
      </span>
    </button>
  );
}
