import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { sheetsOpen } from "@/lib/sheets";
import { onCompactIOS } from "@/test/ios";

// A dialog on a phone stands on the screen's bottom edge, where the floating
// tab bar (#129) floats: while it is up the bar has to be away, or its
// buttons are behind the capsule and a finger on them taps a tab instead
// (#137's TMDB key, and the alert dialogs' own).
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

// What lib/sheets knows: each open sheet, and so each dialog, holds one
// request to hide the bar.
function holds(): number {
  return sheetsOpen();
}

// A dialog kept open by its own button, so a close has something to return to.
function SheetDialog({ sheet }: { sheet: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <DialogPopup sheet={sheet}>
        <DialogTitle>Key</DialogTitle>
        <DialogFooter>
          <DialogClose render={<button type="button" aria-label="Cancel"></button>}>
            Cancel
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Question() {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <button type="button" onClick={() => setOpen(true)}>
        Delete
      </button>
      <AlertDialogPopup>
        <AlertDialogTitle>Delete it?</AlertDialogTitle>
        <AlertDialogFooter>
          <AlertDialogClose render={<button type="button" aria-label="Cancel"></button>}>
            Cancel
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

describe("a dialog on the compact shell", () => {
  it("takes the tab bar away while a sheet's form is up", async () => {
    restore = onCompactIOS();
    const user = userEvent.setup();
    render(<SheetDialog sheet />);
    expect(holds()).toBe(0);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog", { name: "Key" });
    await waitFor(() => expect(holds()).toBe(1));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(holds()).toBe(0));
  });

  it("takes it away for a dialog stuck to the bottom edge too", async () => {
    restore = onCompactIOS();
    const user = userEvent.setup();
    // Not `sheet`: under 640 pt it is still drawn on the bottom edge
    // (bottomStickOnMobile).
    render(<SheetDialog sheet={false} />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog", { name: "Key" });
    await waitFor(() => expect(holds()).toBe(1));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(holds()).toBe(0));
  });

  it("takes it away for a question at the bottom edge", async () => {
    restore = onCompactIOS();
    const user = userEvent.setup();
    render(<Question />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("alertdialog", { name: "Delete it?" });
    await waitFor(() => expect(holds()).toBe(1));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(holds()).toBe(0));
  });

  it("leaves the bar alone off the compact shell", async () => {
    // A Mac (or an iPad at regular width): the bar is not on the screen, and
    // the dialogs there are centred.
    const user = userEvent.setup();
    render(<SheetDialog sheet />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog", { name: "Key" });
    expect(holds()).toBe(0);
  });
});
