import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useId, useState } from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { profilesQuery, useRemoveProfile, useSwitchProfile } from "@/lib/account";
import { useCurrentProfile } from "@/lib/profile";
import type { Profile } from "@bindings/store";

export const Route = createFileRoute("/profiles")({
  staticData: { chrome: "focus" },
  component: Profiles,
});

// Who's watching (#24): shown at launch and after signing in when there's
// more than one profile, and from the profile menu and Settings.
function Profiles() {
  const navigate = useNavigate();
  const router = useRouter();
  const profiles = useQuery(profilesQuery);
  const current = useCurrentProfile();
  const switchProfile = useSwitchProfile();
  const [removing, setRemoving] = useState<Profile>();

  const pick = (profile: Profile) => {
    if (profile.id === current.id) {
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

  const list = profiles.data ?? [];
  // Tiles wait for the current profile too, so the last one used can take
  // focus as they mount.
  const ready = profiles.data !== undefined && current.id !== undefined;
  const guest = list.find((p) => p.guest);
  // The Guest can go once there's another profile to land on.
  const removableGuest = guest && list.length > 1 ? guest : undefined;
  // At launch there's nothing to go back to: picking is the way in.
  const canGoBack = router.history.canGoBack();

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
        Who’s watching?
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
                disabled={switchProfile.isPending}
                onPick={() => pick(profile)}
              />
            </li>
          ))}
      </ul>

      <footer className="flex flex-col items-center gap-4 text-center">
        {current.signedIn || current.sessionEnded ? (
          <p className="max-w-sm text-sm text-balance text-muted-foreground">
            Add, rename and change avatars for your Nuvio profiles in the Nuvio app.
          </p>
        ) : (
          <Link to="/sign-in" className={buttonVariants({ variant: "outline" })}>
            Sign in to bring your Nuvio profiles
          </Link>
        )}
        {removableGuest && (
          <Button variant="ghost" size="sm" onClick={() => setRemoving(removableGuest)}>
            Remove the Guest profile
          </Button>
        )}
      </footer>

      <RemoveProfileDialog profile={removing} onClose={() => setRemoving(undefined)} />
    </div>
  );
}

// One profile: its avatar and name, read out as the name with a note.
function ProfileTile({
  profile,
  current,
  disabled,
  onPick,
}: {
  profile: Profile;
  current: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const noteId = useId();
  const note = profile.guest ? "On this computer" : current ? "Last used" : undefined;
  return (
    <button
      type="button"
      // The last-used profile is a press of Return away.
      // oxlint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={current}
      aria-current={current ? "true" : undefined}
      aria-label={profile.name}
      aria-describedby={note ? noteId : undefined}
      disabled={disabled}
      onClick={onPick}
      className="group flex w-28 flex-col items-center gap-3 rounded-2xl p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64 md:w-32"
    >
      <ProfileAvatar
        profile={profile}
        className="size-24 text-2xl ring-offset-2 ring-offset-background transition-[box-shadow,scale] group-hover:ring-2 group-hover:ring-foreground/24 group-active:scale-96 group-aria-current:ring-2 group-aria-current:ring-primary md:size-28"
      />
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

// Asks before deleting a local profile, since nothing of it is in Nuvio.
function RemoveProfileDialog({
  profile,
  onClose,
}: {
  profile: Profile | undefined;
  onClose: () => void;
}) {
  const remove = useRemoveProfile();
  // Kept while the dialog closes, so its text doesn't blank mid-animation.
  const [shown, setShown] = useState(profile);
  if (profile && profile !== shown) setShown(profile);

  const confirm = () => {
    if (!profile) return;
    remove.mutate(profile, {
      onSuccess: () => {
        onClose();
        toastManager.add({ type: "success", title: `Removed ${profile.name}` });
      },
      onError: (error) => {
        toastManager.add({
          type: "error",
          title: `Couldn’t remove ${profile.name}`,
          description: error.message,
        });
      },
    });
  };

  return (
    <AlertDialog open={profile !== undefined} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {shown?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its library, progress and addons are deleted from this computer. They aren’t in Nuvio,
            so they can’t be brought back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" loading={remove.isPending} onClick={confirm}>
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
