import { useNavigate } from "@tanstack/react-router";

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
import { toastManager } from "@/components/ui/toast";
import { parentSteps, usePinSteps } from "@/components/account/pin-dialog";
import { useSignOut } from "@/lib/account";
import { useCurrentProfile } from "@/lib/profile";

// Asks before signing out (#22): signing out removes the account's profiles
// from this computer, and until sync (#28) can push first, anything not yet
// synced with them.
export function SignOutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const signOut = useSignOut();
  // Signing out of a kids profile asks for its parent PIN first (#26).
  const current = useCurrentProfile();
  const { ask, dialog } = usePinSteps();

  const signOutNow = () =>
    signOut.mutate(undefined, {
      onSuccess: () => {
        onOpenChange(false);
        toastManager.add({ type: "success", title: "Signed out of Nuvio" });
        // Home, or the welcome screen if no profiles are left.
        void navigate({ to: "/" });
      },
      onError: (error) => {
        toastManager.add({ type: "error", title: "Couldn’t sign out", description: error.message });
      },
    });

  const confirm = () => ask(parentSteps(current), signOutNow);

  return (
    <>
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of Nuvio?</AlertDialogTitle>
            <AlertDialogDescription>
              Your Nuvio profiles are removed from this computer, with their library and progress.
              They come back when you sign in again. Anything not yet synced to Nuvio is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" loading={signOut.isPending} onClick={confirm}>
              Sign out
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {dialog}
    </>
  );
}
