import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Lock, Pencil, Plus } from "lucide-react";
import { useId, useState } from "react";

import { FocusScreen, glassButton, pillButton } from "@/components/account/focus-screen";
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
import { thisDevice } from "@/lib/platform";
import { cn } from "@/lib/utils";
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
    <FocusScreen className="max-w-4xl gap-10">
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

      <h1 className="text-center font-display text-[clamp(3rem,2rem+3vw,4.5rem)] leading-none tracking-[-0.01em]">
        {managing ? "Manage profiles" : "Who’s watching?"}
      </h1>

      <ul aria-label="Profiles" className="flex flex-wrap justify-center gap-x-8 gap-y-10">
        {!ready &&
          [0, 1].map((i) => (
            <li key={i}>
              <Skeleton className="size-36 rounded-[2.5rem]" />
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
              className="group flex w-40 flex-col items-center gap-4 rounded-2xl p-2 outline-none"
            >
              <span
                className={cn(
                  tileLift,
                  "flex size-36 items-center justify-center rounded-[2.5rem] bg-foreground/5 text-muted-foreground shadow-[inset_0_0_0_1.5px_var(--border)] group-hover:bg-foreground/8 group-hover:text-foreground group-focus-visible:shadow-[inset_0_0_0_2px_var(--sun)]",
                )}
              >
                <Plus className="size-9" strokeWidth={1.5} />
              </span>
              <span className="min-h-10 type-item">Add profile</span>
            </button>
          </li>
        )}
      </ul>

      <footer className="flex flex-col items-center gap-4 text-center">
        {managing ? (
          <>
            {current.sessionEnded && (
              <p className="max-w-sm text-body text-balance text-muted-foreground">
                Your Nuvio session ended. Sign in again to change your Nuvio profiles; they change
                on every device.
              </p>
            )}
            {current.signedIn && full && (
              <p className="max-w-sm text-body text-balance text-muted-foreground">
                All {maxNuvioProfiles} Nuvio profiles are in use. Delete one to add another.
              </p>
            )}
            <Button
              variant="ghost"
              className={cn(pillButton, glassButton)}
              onClick={() => setManaging(false)}
            >
              Done
            </Button>
          </>
        ) : (
          <>
            {!account && (
              <Link
                to="/sign-in"
                className={cn(buttonVariants({ variant: "ghost" }), pillButton, glassButton)}
              >
                Sign in to bring your Nuvio profiles
              </Link>
            )}
            {ready && (
              <Button
                variant="ghost"
                className={cn(pillButton, glassButton)}
                onClick={() => setManaging(true)}
              >
                <Pencil />
                Manage profiles
              </Button>
            )}
            {removableGuest && (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full before:rounded-full"
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
    </FocusScreen>
  );
}

// The lift a tile's picture takes on hover and focus: a spring to 1.05×, and
// a press back down. Still under reduced motion.
const tileLift =
  "transition-[box-shadow,scale,background-color,color] duration-(--duration-slow) ease-bounce motion-safe:group-hover:scale-[1.05] motion-safe:group-focus-visible:scale-[1.05] motion-safe:group-active:scale-95";

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
      `On ${thisDevice()}`
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
      className="group flex w-40 flex-col items-center gap-4 rounded-2xl p-2 outline-none disabled:opacity-45"
    >
      <span className={cn("relative rounded-[2.5rem]", tileLift)}>
        <ProfileAvatar
          profile={profile}
          className="size-36 rounded-[2.5rem] text-4xl shadow-float ring-offset-4 ring-offset-background transition-shadow group-hover:ring-2 group-hover:ring-foreground/25 group-focus-visible:ring-[3px] group-focus-visible:ring-sun"
        />
        {current && !managing && (
          <span
            aria-hidden
            className="absolute -bottom-2.5 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-sun shadow-sun"
          />
        )}
        {managing && (
          <span
            data-slot="edit-badge"
            className="absolute -end-1 -bottom-1 flex size-10 items-center justify-center rounded-full bg-foreground text-background shadow-float"
          >
            <Pencil className="size-4" />
          </span>
        )}
      </span>
      <span className="flex max-w-full flex-col gap-0.5">
        <span className="truncate text-[0.9375rem] font-[590]">{profile.name}</span>
        {/* Kept when empty, so names line up. */}
        <span id={noteId} className="min-h-4 text-small text-muted-foreground">
          {note}
        </span>
      </span>
    </button>
  );
}
