import { useQuery } from "@tanstack/react-query";
import { Check, Lock, TriangleAlert } from "lucide-react";
import { useState } from "react";

import type { ProfileEdit } from "@bindings/account";
import type { Profile } from "@bindings/store";
import { KidsSection } from "@/components/account/kids-section";
import { PinManagerDialog } from "@/components/account/pin-manager";
import { initialsColor, ProfileAvatar } from "@/components/account/profile-avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioPrimitive } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import {
  avatarsQuery,
  profileProblem,
  profilesQuery,
  useAddProfile,
  useEditProfile,
  useRemoveProfile,
} from "@/lib/account";
import { avatarColors } from "@/lib/profile";

// What the editor is open on: a profile, or a new Nuvio profile.
export type EditorTarget = { profile: Profile } | { add: true };

// The longest name, as in Nuvio's account dashboard; Go checks it too.
const maxNameLength = 80;

// Edits a profile, or adds a Nuvio one (#95). A Nuvio profile changes in
// Nuvio, on every device; the Guest is renamed on this device only.
// `deletable` is false for the primary and the last Nuvio profile, which
// Nuvio's own apps keep.
export function ProfileEditor({
  target,
  deletable,
  onClose,
}: {
  target: EditorTarget | undefined;
  deletable: boolean;
  onClose: () => void;
}) {
  // Kept while the dialog closes, so its content doesn't blank mid-animation.
  const [shown, setShown] = useState(target);
  if (target && target !== shown) setShown(target);
  const [deleting, setDeleting] = useState<Profile>();
  const [pinAction, setPinAction] = useState<{
    profile: Profile;
    mode: "set" | "change" | "clear";
  }>();

  return (
    <>
      <Dialog open={target !== undefined} onOpenChange={(open) => !open && onClose()}>
        <DialogPopup className="sm:max-w-2xl">
          {shown && (
            <EditorForm
              // A fresh form for each profile.
              key={"profile" in shown ? shown.profile.id : "add"}
              target={shown}
              deletable={deletable}
              onDone={onClose}
              onDelete={setDeleting}
              onPinAction={setPinAction}
            />
          )}
        </DialogPopup>
      </Dialog>
      <DeleteProfileDialog
        profile={deleting}
        onClose={() => setDeleting(undefined)}
        onDeleted={() => {
          setDeleting(undefined);
          onClose();
        }}
      />
      <PinManagerDialog
        profile={pinAction?.profile}
        mode={pinAction?.mode ?? "set"}
        open={pinAction !== undefined}
        onClose={() => setPinAction(undefined)}
        onDone={() => setPinAction(undefined)}
      />
    </>
  );
}

function EditorForm({
  target,
  deletable,
  onDone,
  onDelete,
  onPinAction,
}: {
  target: EditorTarget;
  deletable: boolean;
  onDone: () => void;
  onDelete: (profile: Profile) => void;
  onPinAction: (action: { profile: Profile; mode: "set" | "change" | "clear" }) => void;
}) {
  const shownProfile = "profile" in target ? target.profile : undefined;
  // Kids mode and the PIN change from inside the editor, so follow the
  // stored profile rather than the one the editor opened on.
  const profiles = useQuery(profilesQuery);
  const profile = profiles.data?.find((p) => p.id === shownProfile?.id) ?? shownProfile;
  const local = profile?.guest === true;
  const avatars = useQuery({ ...avatarsQuery, enabled: !local });
  const edit = useEditProfile();
  const add = useAddProfile();
  const saving = edit.isPending || add.isPending;
  const error = edit.error ?? add.error;

  const [name, setName] = useState(profile?.name ?? "");
  // The stock avatar it has now, matched by its image, if any.
  const initialAvatar = avatars.data?.find((a) => a.image === profile?.avatar)?.id ?? "";
  const [avatarId, setAvatarId] = useState<string>();
  const avatar = avatarId ?? initialAvatar;
  const [color, setColor] = useState(profile?.avatarColor ?? avatarColors[0]);
  // A colour from elsewhere (the Nuvio app takes any) stays on offer.
  const colors = avatarColors.some((c) => c === color.toUpperCase())
    ? avatarColors
    : [color, ...avatarColors];

  const image = avatars.data?.find((a) => a.id === avatar)?.image ?? profile?.avatar;

  const pickAvatar = (id: string) => {
    setAvatarId(id);
    // Stock avatars are drawn for a colour; start from it.
    const drawnFor = avatars.data?.find((a) => a.id === id)?.color;
    if (drawnFor) setColor(drawnFor);
  };

  const submit = () => {
    const changes: ProfileEdit = {
      name,
      avatarId: avatar !== initialAvatar ? avatar : "",
      avatarColor: local ? "" : color,
    };
    const done = (saved: Profile) => {
      toastManager.add({
        type: "success",
        title: profile ? `Saved ${saved.name}` : `Added ${saved.name}`,
      });
      onDone();
    };
    if (profile) edit.mutate({ profile, edit: changes }, { onSuccess: done });
    else add.mutate(changes, { onSuccess: done });
  };

  const title = profile ? (local ? "Rename the Guest" : `Edit ${profile.name}`) : "Add a profile";
  const problem = error ? profileProblem(error) : undefined;

  return (
    <Form className="contents" onFormSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <ProfileAvatar
            profile={{ name: name || "?", avatar: image, avatarColor: local ? undefined : color }}
            className="size-16 text-xl"
          />
          <Field name="name" className="flex-1 items-stretch">
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              onValueChange={setName}
              required
              maxLength={maxNameLength}
              autoComplete="off"
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
          </Field>
        </div>

        {/* Up top, so it shows without scrolling. */}
        {problem && (
          <Alert variant="error">
            <TriangleAlert />
            <AlertTitle>{problem.title}</AlertTitle>
            <AlertDescription>{problem.description}</AlertDescription>
          </Alert>
        )}
        {local ? (
          <p className="text-body text-muted-foreground">
            The Guest stays on this computer. Its name doesn’t reach Nuvio.
          </p>
        ) : (
          <>
            <section className="flex flex-col gap-3" aria-labelledby="avatar-heading">
              <h3 id="avatar-heading" className="text-item">
                Avatar
              </h3>
              {avatars.isPending && (
                <div className="flex flex-wrap gap-3">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="size-16 rounded-full" />
                  ))}
                </div>
              )}
              {avatars.isError && (
                <p className="text-body text-muted-foreground">
                  Nuvio’s avatars need a connection. The name and colour can still change.
                </p>
              )}
              {avatars.data && (
                <RadioGroup
                  aria-labelledby="avatar-heading"
                  value={avatar}
                  onValueChange={(value) => pickAvatar(String(value))}
                  className="flex flex-row flex-wrap gap-3"
                >
                  {avatars.data.map((a) => (
                    <RadioPrimitive.Root
                      key={a.id}
                      value={a.id}
                      aria-label={a.name}
                      className="size-16 overflow-hidden rounded-full ring-offset-2 ring-offset-transparent outline-none transition-shadow hover:ring-2 hover:ring-foreground/24 focus-visible:ring-2 focus-visible:ring-ring data-checked:ring-2 data-checked:ring-primary"
                      style={a.color ? { backgroundColor: a.color } : undefined}
                    >
                      <img src={a.image} alt="" draggable={false} className="size-full" />
                    </RadioPrimitive.Root>
                  ))}
                </RadioGroup>
              )}
            </section>

            <section className="flex flex-col gap-3" aria-labelledby="color-heading">
              <h3 id="color-heading" className="text-item">
                Colour
              </h3>
              <RadioGroup
                aria-labelledby="color-heading"
                value={color.toUpperCase()}
                onValueChange={(value) => setColor(String(value))}
                className="flex flex-row flex-wrap gap-2"
              >
                {colors.map((c) => (
                  <RadioPrimitive.Root
                    key={c}
                    value={c.toUpperCase()}
                    aria-label={c.toUpperCase()}
                    className="flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-transparent outline-none transition-shadow hover:ring-2 hover:ring-foreground/24 focus-visible:ring-2 focus-visible:ring-ring data-checked:ring-2 data-checked:ring-primary"
                    style={{ backgroundColor: c, color: initialsColor(c) }}
                  >
                    <RadioPrimitive.Indicator>
                      <Check className="size-4" />
                    </RadioPrimitive.Indicator>
                  </RadioPrimitive.Root>
                ))}
              </RadioGroup>
            </section>

            {profile && (
              <section className="flex flex-col gap-3" aria-labelledby="pin-heading">
                <h3 id="pin-heading" className="flex items-center gap-2 text-item">
                  <Lock className="size-4" aria-hidden />
                  PIN
                </h3>
                {profile.pinEnabled ? (
                  <>
                    <p className="text-body text-muted-foreground">
                      This profile needs its PIN to open.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => onPinAction({ profile, mode: "change" })}
                      >
                        Change PIN
                      </Button>
                      {/* A kids profile is left with its PIN, so it keeps it. */}
                      {profile.kids !== true && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => onPinAction({ profile, mode: "clear" })}
                        >
                          Clear PIN
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-body text-muted-foreground">No PIN set.</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => onPinAction({ profile, mode: "set" })}
                      >
                        Set a PIN
                      </Button>
                    </div>
                  </>
                )}
              </section>
            )}

            {profile && <KidsSection profile={profile} />}

            <p className="text-body text-muted-foreground">
              {profile
                ? "Changes show on every device signed in to this Nuvio account."
                : "The new profile starts empty, with Nuvio’s default addons, on every device."}
            </p>
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        {profile && deletable && (
          <Button
            type="button"
            variant="destructive-outline"
            className="sm:me-auto"
            onClick={() => onDelete(profile)}
          >
            {local ? "Remove" : "Delete"}
          </Button>
        )}
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        <Button type="submit" loading={saving}>
          {profile ? "Save" : "Add profile"}
        </Button>
      </DialogFooter>
    </Form>
  );
}

// Asks before deleting a profile. A Nuvio profile goes from every device;
// the Guest was never in Nuvio, so nothing of it can be brought back.
export function DeleteProfileDialog({
  profile,
  onClose,
  onDeleted,
}: {
  profile: Profile | undefined;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const remove = useRemoveProfile();
  const [shown, setShown] = useState(profile);
  if (profile && profile !== shown) setShown(profile);
  const nuvio = shown?.nuvioIndex !== undefined && shown.nuvioIndex !== null;

  const confirm = () => {
    if (!profile) return;
    remove.mutate(profile, {
      onSuccess: () => {
        (onDeleted ?? onClose)();
        toastManager.add({
          type: "success",
          title: `${nuvio ? "Deleted" : "Removed"} ${profile.name}`,
        });
      },
      onError: (error) => {
        toastManager.add({
          type: "error",
          ...profileProblem(error),
          ...(nuvio
            ? {}
            : { title: `Couldn’t remove ${profile.name}`, description: error.message }),
        });
      },
    });
  };

  return (
    <AlertDialog open={profile !== undefined} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {nuvio ? "Delete" : "Remove"} {shown?.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {nuvio
              ? "Its library, progress, addons and settings are deleted from Nuvio, on every device. This can’t be undone."
              : "Its library, progress and addons are deleted from this computer. They aren’t in Nuvio, so they can’t be brought back."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" loading={remove.isPending} onClick={confirm}>
            {nuvio ? "Delete" : "Remove"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
