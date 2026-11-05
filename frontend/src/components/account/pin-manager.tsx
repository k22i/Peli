import { useState } from "react";

import { PinField } from "@/components/account/pin-field";
import type { PinProfile } from "@/components/account/pin-entry";
import { ProfileAvatar } from "@/components/account/profile-avatar";
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
import { toastManager } from "@/components/ui/toast";
import { profileProblem, useClearProfilePIN, useSetProfilePIN } from "@/lib/account";

const pinLength = 4;

type Mode = "set" | "change" | "clear";
type Step = "current" | "choose" | "confirm";

const stepLabels: Record<Step, string> = {
  current: "Enter the current PIN",
  choose: "Choose a PIN",
  confirm: "Confirm the PIN",
};

const stepsFor = (mode: Mode): Step[] =>
  mode === "clear"
    ? ["current"]
    : mode === "set"
      ? ["choose", "confirm"]
      : ["current", "choose", "confirm"];

const titleFor = (mode: Mode) =>
  mode === "set" ? "Set a PIN" : mode === "change" ? "Change PIN" : "Clear PIN";

// Sets, changes or clears a profile's PIN (#25), one 4-digit field at a time.
// A wrong current PIN returns to the current step; a confirm that doesn't
// match restarts the choose step. The backend only ever sees the final pin.
export function PinManagerDialog({
  profile,
  mode,
  open,
  onClose,
  onDone,
}: {
  profile: PinProfile | undefined;
  mode: Mode;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  // Kept while the dialog closes, so its title doesn't flip mid-animation.
  const [shown, setShown] = useState<{ profile: PinProfile; mode: Mode }>();
  if (profile && (!shown || shown.profile !== profile || shown.mode !== mode)) {
    setShown({ profile, mode });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{titleFor(shown?.mode ?? mode)}</DialogTitle>
        </DialogHeader>
        {/* Remounts on each open, so the wizard always starts at step one. */}
        {shown && open && <PinWizard profile={shown.profile} mode={shown.mode} onDone={onDone} />}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PinWizard({
  profile,
  mode,
  onDone,
}: {
  profile: PinProfile;
  mode: Mode;
  onDone: () => void;
}) {
  const set = useSetProfilePIN();
  const clear = useClearProfilePIN();
  const waiting = set.isPending || clear.isPending;

  const steps = stepsFor(mode);
  const [step, setStep] = useState(0);
  const [digits, setDigits] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [problem, setProblem] = useState<{ title: string; description?: string }>();

  const profileId = profile.id;
  const kind = steps[step];

  const fail = (error: Error) => {
    if (wrongPin(error)) {
      // Back to the current step, cleared, to try the current PIN again.
      setProblem({ title: "Wrong PIN. Try again." });
      setStep(0);
      setCurrentPin("");
      setNewPin("");
      setDigits("");
    } else {
      setProblem(profileProblem(error));
      setDigits("");
    }
  };

  const succeed = (title: string) => {
    toastManager.add({ type: "success", title });
    onDone();
  };

  const advance = (value: string) => {
    if (waiting || profileId === undefined) return;
    if (kind === "current") {
      if (mode === "clear") {
        clear.mutate(
          { profileId, currentPin: value },
          {
            onSuccess: () => succeed("PIN cleared"),
            onError: fail,
          },
        );
        return;
      }
      setCurrentPin(value);
      setDigits("");
      setProblem(undefined);
      setStep(step + 1);
    } else if (kind === "choose") {
      setNewPin(value);
      setDigits("");
      setProblem(undefined);
      setStep(step + 1);
    } else if (value !== newPin) {
      setProblem({ title: "PINs don't match. Try again." });
      setNewPin("");
      setDigits("");
      setStep(mode === "set" ? 0 : 1);
    } else {
      set.mutate(
        { profileId, pin: value, currentPin: mode === "change" ? currentPin : "" },
        {
          onSuccess: () => succeed(mode === "change" ? "PIN changed" : "PIN set"),
          onError: fail,
        },
      );
    }
  };

  const enter = (value: string) => {
    setDigits(value);
    if (value.length === pinLength) advance(value);
  };

  return (
    <DialogPanel className="flex flex-col items-center gap-4">
      <ProfileAvatar profile={profile} className="size-16 text-xl" />
      <p className="text-item">{profile.name}</p>

      <p className="text-body text-muted-foreground">{kind ? stepLabels[kind] : ""}</p>

      <PinField value={digits} disabled={waiting} onValueChange={enter} />

      {problem && (
        <p role="alert" className="text-body text-destructive">
          {problem.description ? problem.title + " " + problem.description : problem.title}
        </p>
      )}
    </DialogPanel>
  );
}

function wrongPin(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause: unknown = error.cause;
  return (
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "wrong_pin"
  );
}
