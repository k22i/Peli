import { useEffect, useState } from "react";

import { PinField } from "@/components/account/pin-field";
import { ProfileAvatar } from "@/components/account/profile-avatar";
import {
  pinRetryAfterSeconds,
  profileProblem,
  useApproveParent,
  useUnlockProfile,
} from "@/lib/account";
import type { Profile } from "@/lib/profile";

const pinLength = 4;

// What a PIN form reads off a profile (#25): who to unlock, and how to show
// them. Both the store's Profile and the local Profile fit this shape.
export type PinProfile = Pick<Profile, "id" | "name" | "avatar" | "avatarColor">;

// What the PIN is for: "unlock" lets a locked profile be entered (#25);
// "parent" is a kids profile's PIN, asked to leave it or change things (#26).
export type PinMode = "unlock" | "parent";

// Enter a profile's 4-digit PIN: a numeric field plus an on-screen keypad, so
// it works with a mouse and a keyboard. Submits as soon as four digits are
// in; a wrong PIN clears the field and, after too many attempts, counts down
// Go's cooldown.
export function PinEntry({
  profile,
  mode = "unlock",
  onUnlocked,
}: {
  profile: PinProfile;
  mode?: PinMode;
  onUnlocked: () => void;
}) {
  const unlockProfile = useUnlockProfile();
  const approveParent = useApproveParent();
  const unlock = mode === "parent" ? approveParent : unlockProfile;
  const [pin, setPin] = useState("");
  const [retryIn, setRetryIn] = useState(0);
  // Counts wrong PINs, so the dots shake each time.
  const [wrong, setWrong] = useState(0);
  const [problem, setProblem] = useState<{ title: string; description?: string }>();

  const waiting = unlock.isPending || retryIn > 0;

  // Count down the cooldown, re-enabling the keypad when it ends.
  useEffect(() => {
    if (retryIn <= 0) return undefined;
    const timer = setTimeout(() => setRetryIn((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryIn]);

  const submit = (digits: string) => {
    const profileId = profile.id;
    if (digits.length !== pinLength || waiting || profileId === undefined) return;
    setPin("");
    setProblem(undefined);
    unlock.mutate(
      { profileId, pin: digits },
      {
        onSuccess: () => onUnlocked(),
        onError: (error) => {
          const retry = pinRetryAfterSeconds(error);
          if (retry > 0) {
            setRetryIn(retry);
            setProblem(undefined);
            setWrong((n) => n + 1);
          } else if (wrongPin(error)) {
            setProblem({ title: "Wrong PIN. Try again." });
            setWrong((n) => n + 1);
          } else {
            setProblem(profileProblem(error));
          }
        },
      },
    );
  };

  const enter = (digits: string) => {
    setPin(digits);
    if (digits.length === pinLength && !waiting) submit(digits);
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <ProfileAvatar profile={profile} className="size-20 text-2xl" />
      <p className="text-item">{profile.name}</p>
      {mode === "parent" && (
        <p className="max-w-56 text-center text-body text-muted-foreground">
          Ask a parent to enter the PIN.
        </p>
      )}

      <PinField value={pin} disabled={waiting} shake={wrong} onValueChange={enter} />

      {retryIn > 0 ? (
        <p role="alert" className="text-body text-destructive">
          Too many attempts. Try again in {retryIn}s.
        </p>
      ) : (
        problem && (
          <p role="alert" className="text-body text-destructive">
            {problem.description ? problem.title + " " + problem.description : problem.title}
          </p>
        )
      )}
    </div>
  );
}

function wrongPin(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause: unknown = error.cause;
  return (
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "wrong_pin"
  );
}
