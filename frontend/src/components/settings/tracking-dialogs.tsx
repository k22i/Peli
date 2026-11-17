import { useMutation } from "@tanstack/react-query";
import { closeSignInPage, openSignInPage, openURL } from "@/lib/open-url";
import { Check, Copy, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Spinner } from "@/components/ui/spinner";
import { isIOS, thisDevice } from "@/lib/platform";
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
    onSuccess: (code) => void openURL(code.url),
  });
  const wait = useWaitSignIn(profileId, () => Tracking.WaitSimkl());
  const code = start.data;
  const secondsLeft = useSecondsLeft(code?.expiresAt);
  // On a phone or tablet the code is easier to approve elsewhere, such as on
  // the Mac (#133), so it's big, and copyable.
  const phone = isIOS();
  const [copied, setCopied] = useState(false);

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
          {phone
            ? "Approve this code on any device, like your Mac, or on the SIMKL page that opened. What this profile watches is then scrobbled to your SIMKL account."
            : "Allow Peli on the SIMKL page that opened in your browser. What this profile watches is then scrobbled to your SIMKL account."}
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
                  onClick={() => void openURL(code.url)}
                >
                  {code.pageUrl.replace(/^https?:\/\//, "")}
                </button>{" "}
                and enter
              </p>
              <p
                className={
                  phone
                    ? "tnum text-5xl font-semibold tracking-[0.15em] select-text"
                    : "tnum text-3xl font-semibold tracking-[0.15em]"
                }
              >
                {code.code}
              </p>
              {phone && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    void navigator.clipboard.writeText(code.code).then(
                      () => setCopied(true),
                      () => toastManager.add({ type: "error", title: "Couldn’t copy the code" }),
                    )
                  }
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy code"}
                </Button>
              )}
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
          <Button type="button" variant="outline" onClick={() => void openURL(code.url)}>
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
    // On iOS a sheet over the app: Safari would suspend it, and the page
    // AniList redirects to is served by it (ADR-0059).
    onSuccess: (url) => void openSignInPage(url),
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
  useEffect(() => {
    begin();
    return closeSignInPage;
    // oxlint-disable-next-line react/exhaustive-deps -- start once, as the dialog opens.
  }, []);

  const failure =
    start.error ?? (trackingErrorCode(wait.error) === "no_sign_in" ? null : wait.error);
  useEffect(() => {
    if (failure) closeSignInPage();
  }, [failure]);
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
          <Button type="button" variant="outline" onClick={() => void openSignInPage(start.data)}>
            <ExternalLink />
            Open AniList
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

// Disconnecting a grant that pairing copied to or from other devices (#133,
// ADR-0061). SIMKL asks: forget it here only, or revoke it, which signs the
// other devices out too. AniList can't be revoked from Peli, so it only
// forgets, and says the other devices stay connected.
export function SharedDisconnectDialog({
  service,
  devices,
  open,
  onOpenChange,
  onThisDevice,
  onEverywhere,
}: {
  service: "simkl" | "anilist";
  // sharedWith() of the connection's devices.
  devices: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThisDevice: () => void;
  onEverywhere?: () => void;
}) {
  const simkl = service === "simkl";
  const choose = (run: () => void) => () => {
    run();
    onOpenChange(false);
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{simkl ? "Disconnect SIMKL?" : "Disconnect AniList?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {simkl
              ? `This SIMKL connection is shared with ${devices}. Disconnect it here only, and ${devices} keeps scrobbling, or everywhere, which signs ${devices} out of SIMKL too.`
              : `This only forgets AniList on ${thisDevice()}: ${devices} stays connected. To disconnect everywhere, remove Peli in your AniList settings.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          {simkl && onEverywhere && (
            <Button variant="destructive-outline" onClick={choose(onEverywhere)}>
              Everywhere
            </Button>
          )}
          <Button variant={simkl ? "default" : "destructive"} onClick={choose(onThisDevice)}>
            {simkl ? "On this device only" : "Disconnect"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function connected(service: string, user: string | undefined) {
  toastManager.add({
    type: "success",
    title: user ? `${service} connected as ${user}` : `${service} connected`,
  });
}

export function formatLeft(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `expires in ${m}:${s}`;
}

// Whole seconds until expiresAt, ticking every second; 0 once it's past.
export function useSecondsLeft(expiresAt: string | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}
