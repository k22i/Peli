import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Browser } from "@wailsio/runtime";
import { ArrowLeft, LockKeyhole, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { FocusScreen } from "@/components/account/focus-screen";
import { SignInProblem, problemFor } from "@/components/account/sign-in-problem";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  needsPicker,
  profilesQuery,
  qrCodeQuery,
  signInErrorCode,
  useQRSignIn,
} from "@/lib/account";

export const Route = createFileRoute("/qr-sign-in")({
  staticData: { chrome: "focus" },
  component: QRSignIn,
});

// QR sign-in (#21, ADR-0013): the phone's camera opens Nuvio's "Link a
// device" page with the code filled in, and the user approves Sinag there,
// or types the short code at nuvio.tv/link on any device. Go polls and keeps
// the session; this page never sees a token.
function QRSignIn() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const profiles = useQuery(profilesQuery);
  const qr = useQuery(qrCodeQuery);
  const code = qr.isFetching ? undefined : qr.data;
  const secondsLeft = useSecondsLeft(code?.expiresAt);

  const failure = useQRSignIn(code?.code, (profile) => {
    // With more than one profile, the picker asks which (#24).
    if (needsPicker(queryClient.getQueryData(profilesQuery.queryKey))) {
      toastManager.add({ type: "success", title: "Signed in to Nuvio" });
      void navigate({ to: "/profiles", replace: true });
      return;
    }
    toastManager.add({ type: "success", title: `Signed in as ${profile.name}` });
    void navigate({ to: "/" });
  });
  const expired =
    (code !== undefined && secondsLeft === 0) || signInErrorCode(failure) === "qr_expired";
  const error = qr.error ?? (expired ? undefined : failure);
  const newCode = () => void qr.refetch();

  const firstRun = profiles.data?.length === 0;
  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: firstRun ? "/welcome" : "/settings" });
  };

  return (
    <FocusScreen className="max-w-md gap-6 py-8">
      <Button variant="ghost" size="sm" className="-ms-2.5 self-start" onClick={back}>
        <ArrowLeft />
        Back
      </Button>

      <div className="flex flex-col gap-6 glass-thick rounded-3xl p-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-title">Sign in with your phone</h1>
          <p className="text-pretty text-muted-foreground">
            Scan the code with your phone’s camera, sign in to Nuvio on the page that opens, and
            approve Sinag.
          </p>
        </header>

        <div className="flex flex-col items-center gap-6">
          {/* Dark on white in both themes: phone cameras read that best. */}
          {!qr.error && (
            <div className="relative size-52 rounded-2xl bg-white p-4 shadow-lift">
              {code ? (
                <img
                  src={qrImage(code.size, code.path)}
                  alt={`QR code for ${code.url}`}
                  className={cn("size-full", (expired || error) && "opacity-15 blur-[2px]")}
                />
              ) : (
                <Spinner className="absolute inset-0 m-auto size-6 text-neutral-500" />
              )}
              {code && expired && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                  <p className="font-medium text-neutral-900">The code expired</p>
                  <Button onClick={newCode}>
                    <RefreshCw />
                    New code
                  </Button>
                </div>
              )}
            </div>
          )}

          {code && !expired && !error && (
            <>
              <div className="flex flex-col items-center gap-2">
                <p className="text-body text-muted-foreground">
                  Or go to{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-4 hover:text-brand"
                    onClick={() => void Browser.OpenURL(code.url)}
                  >
                    {code.linkUrl.replace(/^https?:\/\//, "")}
                  </button>{" "}
                  and enter
                </p>
                <p
                  className="font-mono text-4xl font-semibold tracking-[0.2em] tabular-nums"
                  aria-label={code.code.split("").join(" ")}
                >
                  <span aria-hidden>{code.code.slice(0, 3)}</span>
                  <span aria-hidden className="ms-[0.4em]">
                    {code.code.slice(3)}
                  </span>
                </p>
              </div>
              <div className="flex w-full flex-col items-center gap-2">
                <p className="flex items-center gap-2 text-body whitespace-nowrap text-muted-foreground">
                  <Spinner className="size-4" aria-hidden />
                  Waiting for approval ·{" "}
                  <span className="tabular-nums">{formatLeft(secondsLeft)}</span>
                </p>
                <Button size="sm" variant="ghost" onClick={newCode}>
                  <RefreshCw />
                  New code
                </Button>
              </div>
            </>
          )}
        </div>

        {error && (
          <SignInProblem
            problem={problemFor(error)}
            action={
              <Button size="sm" variant="outline" onClick={newCode}>
                Try again
              </Button>
            }
          />
        )}

        <p className="flex gap-2 text-body text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden />
          You never type your password here. Your session is stored in this computer’s keychain.
        </p>
      </div>
    </FocusScreen>
  );
}

// The QR code's modules as an SVG image, black on transparent.
function qrImage(size: number, path: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// "expires in 4:59", counting down.
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
