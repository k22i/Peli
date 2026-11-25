import { useState, type FormEvent } from "react";

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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { errorCode } from "@/lib/error-code";
import { useSourceActions, type Source } from "@/lib/livetv";

// The Live TV pane's three dialogs (ADR-0066): adding a source, renaming one,
// and removing one. A source's playlist and guide links are the keychain's,
// so no dialog ever shows them again; Go owns the fetching and the parsing,
// and answers a bad link with a code (addErrorText).

// Adding a source: a playlist link, an optional name and an optional guide.
// The two links are the only place a user name and password can be, so they
// are never repeated in a toast, an error or anywhere else.
export function AddSourceDialog({
  open,
  onOpenChange,
  profileId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup sheet className="sm:max-w-md">
        {/* A fresh form each time it opens: the fields and the error start
        empty. */}
        {open && <AddSourceForm profileId={profileId} onDone={() => onOpenChange(false)} />}
      </DialogPopup>
    </Dialog>
  );
}

function AddSourceForm({ profileId, onDone }: { profileId: number; onDone: () => void }) {
  const { add } = useSourceActions(profileId);
  const [name, setName] = useState("");
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [guideUrl, setGuideUrl] = useState("");
  const [error, setError] = useState<string>();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (playlistUrl.trim() === "") return;
    add.mutate(
      { name: name.trim(), playlistUrl: playlistUrl.trim(), guideUrl: guideUrl.trim() },
      {
        onSuccess: () => {
          onDone();
          // What changed, never how: the links stay where they were put.
          toastManager.add({
            title: "Source added",
            description: "Its channels will show in Live TV in a moment.",
          });
        },
        onError: (failure: Error) => setError(addErrorText(errorCode(failure))),
      },
    );
  };

  return (
    <form className="contents" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Add a Live TV source</DialogTitle>
        <DialogDescription>
          Peli reads the channels from the playlist and the programme guide from the guide link.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        <Field name="name" className="items-stretch">
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            onValueChange={setName}
            placeholder="Taken from the link"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field name="playlist" className="items-stretch">
          <FieldLabel>Playlist link</FieldLabel>
          <Input
            value={playlistUrl}
            onValueChange={setPlaylistUrl}
            inputMode="url"
            placeholder="https://… or a file path"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field name="guide" className="items-stretch">
          <FieldLabel>Guide link</FieldLabel>
          <Input
            value={guideUrl}
            onValueChange={setGuideUrl}
            inputMode="url"
            placeholder="From the playlist, if it names one"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        {error && (
          <p role="alert" className="text-small text-destructive-foreground">
            {error}
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        <Button type="submit" loading={add.isPending} disabled={playlistUrl.trim() === ""}>
          Add
        </Button>
      </DialogFooter>
    </form>
  );
}

// What AddSource refused with, as a sentence.
export function addErrorText(code: string | undefined): string {
  switch (code) {
    case "invalid":
      return "Enter an http(s) link, a file:// link or a file path.";
    case "keychain":
      return "Peli couldn’t keep the link in the keychain.";
    case "kids_profile":
      return "Kids profiles don’t have Live TV.";
    default:
      return "The source couldn’t be added.";
  }
}

// Renaming one: the name only, which is all the store keeps of a source
// besides its timestamps. Undefined means the dialog is closed.
export function RenameSourceDialog({
  source,
  onOpenChange,
  profileId,
}: {
  source: Source | undefined;
  onOpenChange: (open: boolean) => void;
  profileId: number;
}) {
  return (
    <Dialog open={source !== undefined} onOpenChange={onOpenChange}>
      <DialogPopup sheet className="sm:max-w-md">
        {source && (
          <RenameSourceForm
            source={source}
            profileId={profileId}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function RenameSourceForm({
  source,
  profileId,
  onDone,
}: {
  source: Source;
  profileId: number;
  onDone: () => void;
}) {
  const { rename } = useSourceActions(profileId);
  const [name, setName] = useState(source.name);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() === "") return;
    rename.mutate({ id: source.id, name: name.trim() }, { onSuccess: onDone });
  };

  return (
    <form className="contents" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Rename source</DialogTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        <Field name="name" className="items-stretch">
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            onValueChange={setName}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        <Button type="submit" loading={rename.isPending} disabled={name.trim() === ""}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

// Removing one: its channels, its favourites and its guide go with it, but
// the playlist itself is someone else's file on someone else's server. A kid
// never gets here: Go refuses it with kids_profile.
export function RemoveSourceDialog({
  source,
  onOpenChange,
  profileId,
}: {
  source: Source | undefined;
  onOpenChange: (open: boolean) => void;
  profileId: number;
}) {
  const { remove } = useSourceActions(profileId);
  const confirmed = () => {
    if (source) remove.mutate(source.id);
    onOpenChange(false);
  };
  return (
    <AlertDialog open={source !== undefined} onOpenChange={onOpenChange}>
      {source && (
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {source.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its channels, favourites and guide leave Peli on this device. The playlist itself
              isn’t touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmed}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      )}
    </AlertDialog>
  );
}
