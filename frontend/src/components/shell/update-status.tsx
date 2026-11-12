import { ArrowDownToLine } from "lucide-react";
import { useState } from "react";

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
import { readyVersion, useRestartToUpdate, useUpdateStatus } from "@/lib/updates";

// A pill beside the profile menu once an update is downloaded and checked
// (#83). It asks before restarting: nothing restarts by itself. The top bar
// isn't on the player screen, so it can't be pressed mid-film.
export function UpdateStatus() {
  const version = readyVersion(useUpdateStatus());
  const [open, setOpen] = useState(false);
  if (!version) return null;
  return (
    <>
      <button
        type="button"
        aria-label={`Peli ${version} is ready. Restart to update`}
        onClick={() => setOpen(true)}
        className="flex h-7 items-center gap-1.5 rounded-full bg-sun/14 px-2.5 text-small font-[590] text-sun-ink outline-none transition-colors hover:bg-sun/22 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0"
      >
        <ArrowDownToLine aria-hidden />
        <span aria-hidden className="hidden lg:inline">
          Update
        </span>
      </button>
      <RestartDialog version={version} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function RestartDialog({
  version,
  open,
  onOpenChange,
}: {
  version: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const restart = useRestartToUpdate();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart to update?</AlertDialogTitle>
          <AlertDialogDescription>
            Peli {version} is downloaded. Peli closes and opens again on the new version, which
            takes a few seconds. Your library and settings stay as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Later</AlertDialogClose>
          <Button loading={restart.isPending} onClick={() => restart.mutate()}>
            Restart
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
