import { useState } from "react";

import { PinEntry, type PinProfile } from "@/components/account/pin-entry";
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
import type { Profile } from "@/lib/profile";

// Asks for a profile's PIN before switching to or editing it (#25). Go owns
// the enforcement: the frontend prompts, then calls Account.UnlockProfile.
export function PinDialog({
  profile,
  open,
  onClose,
  onUnlocked,
}: {
  profile: PinProfile | undefined;
  open: boolean;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  // Kept while the dialog closes, so its content doesn't blank mid-animation.
  const [shown, setShown] = useState(profile);
  if (profile && profile !== shown) setShown(profile);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Enter PIN</DialogTitle>
        </DialogHeader>
        {shown && (
          <DialogPanel>
            <PinEntry
              // A fresh entry for each profile.
              key={shown.id}
              profile={shown}
              onUnlocked={() => {
                onUnlocked();
                onClose();
              }}
            />
          </DialogPanel>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// The app shell when the current profile is locked at launch: a full-screen,
// non-dismissible card. Unlocking returns to the app in place.
export function PinGate({ profile }: { profile: Profile }) {
  const [unlocked, setUnlocked] = useState(false);
  if (unlocked) return null;
  return (
    <section className="grid min-h-full place-items-center p-6">
      <div className="flex w-full max-w-xs flex-col items-center gap-6 rounded-2xl border bg-popover p-8 text-center shadow-lg">
        <h1 className="font-heading text-xl">This profile is locked</h1>
        <PinEntry profile={profile} onUnlocked={() => setUnlocked(true)} />
      </div>
    </section>
  );
}
