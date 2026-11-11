import { useState } from "react";

import { Ambient } from "@/components/media/ambient";
import { PinEntry, type PinMode, type PinProfile } from "@/components/account/pin-entry";
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

// Asks for a profile's PIN before switching to or editing it (#25), or for a
// kids profile's parent PIN (#26). Go owns the enforcement: the frontend
// prompts, then calls Account.UnlockProfile or ApproveParent. onUnlocked
// closes nothing: the caller decides what comes next.
export function PinDialog({
  profile,
  mode = "unlock",
  open,
  onClose,
  onUnlocked,
}: {
  profile: PinProfile | undefined;
  mode?: PinMode;
  open: boolean;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  // Kept while the dialog closes, so its content doesn't blank mid-animation.
  const [shown, setShown] = useState({ profile, mode });
  if (profile && (profile !== shown.profile || mode !== shown.mode)) setShown({ profile, mode });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{shown.mode === "parent" ? "Enter parent PIN" : "Enter PIN"}</DialogTitle>
        </DialogHeader>
        {shown.profile && (
          <DialogPanel>
            <PinEntry
              // A fresh entry for each profile and kind of PIN.
              key={`${shown.mode}-${shown.profile.id}`}
              profile={shown.profile}
              mode={shown.mode}
              onUnlocked={onUnlocked}
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
    <section className="relative isolate grid min-h-full place-items-center p-6">
      <Ambient tone="sun" />
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-[1.75rem] bg-card p-9 text-center shadow-float hairline">
        <h1 className="type-row">This profile is locked</h1>
        <PinEntry profile={profile} onUnlocked={() => setUnlocked(true)} />
      </div>
    </section>
  );
}

// One PIN to ask, and which kind.
export type PinStep = { profile: PinProfile; mode: PinMode };

// What deciding the PINs to ask needs to know about a profile. Both the
// store's Profile and the local one fit.
export type Gated = PinProfile & {
  pinEnabled?: boolean | undefined;
  kids?: boolean | undefined;
};

// The PINs to ask before leaving the profile in use for `target`, or before
// changing it (`edit`). A kids profile in use needs its parent PIN for
// anything but staying; a kids profile being edited needs its own; and a
// locked profile needs its PIN to be entered (#25, #26). Go checks the same
// rules, so this is only about asking in the right order.
export function pinSteps(current: Gated, target: Gated, intent: "switch" | "edit"): PinStep[] {
  const steps: PinStep[] = [];
  const staying = target.id === current.id;
  if (current.kids && (intent === "edit" || !staying)) {
    steps.push({ profile: current, mode: "parent" });
  }
  if (target.kids && intent === "edit") {
    // The same PIN as the one just asked for, if the target is in use.
    if (!(staying && current.kids)) steps.push({ profile: target, mode: "parent" });
  } else if (target.pinEnabled) {
    steps.push({ profile: target, mode: "unlock" });
  }
  return steps;
}

// Asks for each PIN in turn, then calls onDone. Cancelling any of them stops.
export function PinSteps({
  steps,
  onDone,
  onCancel,
}: {
  steps: PinStep[] | undefined;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [seen, setSeen] = useState(steps);
  // A new set of steps starts from the first.
  if (steps !== seen) {
    setSeen(steps);
    setIndex(0);
  }
  const step = steps?.[index];
  return (
    <PinDialog
      profile={step?.profile}
      mode={step?.mode ?? "unlock"}
      open={steps !== undefined}
      onClose={onCancel}
      onUnlocked={() => {
        if (steps && index + 1 < steps.length) setIndex(index + 1);
        else onDone();
      }}
    />
  );
}

// Asks for PINs when something needs them: `ask(steps, run)` runs `run`
// at once if there are none, or after each has been entered. Render `dialog`
// somewhere in the screen.
export function usePinSteps() {
  const [asking, setAsking] = useState<{ steps: PinStep[]; run: () => void }>();
  const ask = (steps: PinStep[], run: () => void) => {
    if (steps.length === 0) run();
    else setAsking({ steps, run });
  };
  const dialog = (
    <PinSteps
      steps={asking?.steps}
      onDone={() => {
        const run = asking?.run;
        setAsking(undefined);
        run?.();
      }}
      onCancel={() => setAsking(undefined)}
    />
  );
  return { ask, dialog };
}

// The parent PIN a kids profile in use asks for before something that
// leaves or changes it (#26); nothing for any other profile.
export function parentSteps(current: Gated): PinStep[] {
  return current.kids ? [{ profile: current, mode: "parent" }] : [];
}
