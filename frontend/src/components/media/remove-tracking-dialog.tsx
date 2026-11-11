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

// Asked before a title is taken off the lists while SIMKL is one of the
// services that gets the change: SIMKL has no call that only removes it from
// a list, so Peli uses its history removal, which clears the title's watch
// history there too.
export function RemoveTrackingDialog({
  open,
  onOpenChange,
  onConfirm,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  // Where focus goes when it closes; the default is what had it before.
  finalFocus?: () => HTMLElement | boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup {...(finalFocus ? { finalFocus } : {})}>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove from your SIMKL lists?</AlertDialogTitle>
          <AlertDialogDescription>
            SIMKL removes its watch history for this title too. Peli’s own watched marks stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
