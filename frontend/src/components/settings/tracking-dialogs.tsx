import { useMutation } from "@tanstack/react-query";
import { Browser } from "@wailsio/runtime";
import { ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { Tracking, trackingErrorCode, trackingProblem, useWaitSignIn } from "@/lib/tracking";

// Connecting SIMKL (#72): SIMKL's device sign-in. Peli opens SIMKL's page
// with the code filled in; the user clicks Allow there, and Go polls until
// they do. The code is shown too, for signing in on another device.
export function SimklDialog({
  profileId,
  open,
  onOpenChange,
}: {
  profileId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void Tracking.CancelSimkl();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        {open && <SimklSignIn profileId={profileId} onDone={() => onOpenChange(false)} />}
      </DialogPopup>
    </Dialog>
  );
}

function SimklSignIn({ profileId, onDone }: { profileId: number; onDone: () => void }) {
  const start = useMutation({
    mutationFn: () => Tracking.StartSimkl(profileId),
    onSuccess: (code) => void Browser.OpenURL(code.url),
  });
  const wait = useWaitSignIn(profileId, () => Tracking.WaitSimkl());
  const code = start.data;
  const secondsLeft = useSecondsLeft(code?.expiresAt);

  const begin = () => {
    wait.reset();
    start.mutate(undefined, {
      onSuccess: () =>
        wait.mutate(undefined, {
          onSuccess: (connections) => {
            onDone();
            connected("SIMKL", connections.simkl?.user);
          },
        }),
    });
  };
  // oxlint-disable-next-line react/exhaustive-deps -- start once, as the dialog opens.
  useEffect(begin, []);

  // A cancelled wait (a new code replaced it) isn't a failure.
  const failure =
    start.error ?? (trackingErrorCode(wait.error) === "no_sign_in" ? null : wait.error);
  const expired =
    (code !== undefined && secondsLeft === 0) || trackingErrorCode(failure) === "sign_in_expired";
  const problem = failure && !expired ? trackingProblem(failure, "SIMKL") : undefined;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect SIMKL</DialogTitle>
        <DialogDescription>
          Allow Peli on the SIMKL page that opened in your browser. What this profile watches is
          then scrobbled to your SIMKL account.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col items-center gap-5">
        {!code && !problem && <Spinner className="size-6 text-muted-foreground" />}
        {code && !expired && !problem && (
          <>
            <div className="flex flex-col items-center gap-1.5">
              <p className="text-body text-muted-foreground">
                Or go to{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4 hover:text-sun-ink"
                  onClick={() => void Browser.OpenURL(code.url)}
                >
                  {code.pageUrl.replace(/^https?:\/\//, "")}
                </button>{" "}
                and enter
              </p>
              <p className="tnum text-3xl font-semibold tracking-[0.15em]">{code.code}</p>
            </div>
            <p className="flex items-center gap-2 text-body whitespace-nowrap text-muted-foreground">
              <Spinner className="size-4" aria-hidden />
              Waiting for SIMKL · <span className="tabular-nums">{formatLeft(secondsLeft)}</span>
            </p>
          </>
        )}
        {expired && <p className="font-medium">The code expired</p>}
        {problem && (
          <Alert variant="error">
            <TriangleAlert />
            <AlertTitle>{problem.title}</AlertTitle>
            {problem.description && <AlertDescription>{problem.description}</AlertDescription>}
          </Alert>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        {code && !expired && !problem ? (
          <Button type="button" variant="outline" onClick={() => void Browser.OpenURL(code.url)}>
            <ExternalLink />
            Open SIMKL
          </Button>
        ) : (
          <Button type="button" loading={start.isPending} onClick={begin}>
            <RefreshCw />
            New code
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

// Connecting AniList (#104): Peli opens AniList's approval page, and AniList
// sends the browser back to a page Peli serves on this computer, which
// hands the token to Go.
export function AniListDialog({
  profileId,
  open,
  onOpenChange,
}: {
  profileId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void Tracking.CancelAniList();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        {open && <AniListSignIn profileId={profileId} onDone={() => onOpenChange(false)} />}
      </DialogPopup>
    </Dialog>
  );
}

function AniListSignIn({ profileId, onDone }: { profileId: number; onDone: () => void }) {
  const start = useMutation({
    mutationFn: () => Tracking.StartAniList(profileId),
    onSuccess: (url) => void Browser.OpenURL(url),
  });
  const wait = useWaitSignIn(profileId, () => Tracking.WaitAniList());

  const begin = () => {
    wait.reset();
    start.mutate(undefined, {
      onSuccess: () =>
        wait.mutate(undefined, {
          onSuccess: (connections) => {
            onDone();
            connected("AniList", connections.anilist?.user);
          },
        }),
    });
  };
  // oxlint-disable-next-line react/exhaustive-deps -- start once, as the dialog opens.
  useEffect(begin, []);

  const failure =
    start.error ?? (trackingErrorCode(wait.error) === "no_sign_in" ? null : wait.error);
  const problem = failure ? trackingProblem(failure, "AniList") : undefined;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect AniList</DialogTitle>
        <DialogDescription>
          Approve Peli on the AniList page that opened in your browser. Anime this profile watches
          then moves along on your AniList list.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col items-center gap-5">
        {!problem && (
          <p className="flex items-center gap-2 text-body text-muted-foreground">
            <Spinner className="size-4" aria-hidden />
            Waiting for AniList
          </p>
        )}
        {problem && (
          <Alert variant="error">
            <TriangleAlert />
            <AlertTitle>{problem.title}</AlertTitle>
            {problem.description && <AlertDescription>{problem.description}</AlertDescription>}
          </Alert>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        {problem || !start.data ? (
          <Button type="button" loading={start.isPending} onClick={begin}>
            <RefreshCw />
            Try again
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={() => void Browser.OpenURL(start.data)}>
            <ExternalLink />
            Open AniList
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function connected(service: string, user: string | undefined) {
  toastManager.add({
    type: "success",
    title: user ? `${service} connected as ${user}` : `${service} connected`,
  });
}

function formatLeft(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `expires in ${m}:${s}`;
}

// Whole seconds until expiresAt, ticking every second; 0 once it's past.
function useSecondsLeft(expiresAt: string | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}
