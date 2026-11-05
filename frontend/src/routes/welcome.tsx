import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Info, KeyRound, Mail, QrCode, TriangleAlert } from "lucide-react";

import { FocusScreen, glassButton, pillButton } from "@/components/account/focus-screen";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { keychainQuery, useContinueAsGuest } from "@/lib/account";
import { contentDisclaimer } from "@/lib/disclaimer";
import { serverName, serverQuery } from "@/lib/server";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/welcome")({
  staticData: { chrome: "focus" },
  component: Welcome,
});

// First run (#20): sign in to Nuvio, or carry on as a guest with everything
// kept on this device (#23).
function Welcome() {
  const navigate = useNavigate();
  const keychain = useQuery(keychainQuery);
  // The user's own server (#34) has no phone sign-in.
  const server = useQuery(serverQuery);
  const guest = useContinueAsGuest();
  // Signing in needs somewhere safe to keep the session (ADR-0007).
  const noKeychain = keychain.data ?? null;

  const continueAsGuest = () =>
    guest.mutate(undefined, {
      onSuccess: () => void navigate({ to: "/" }),
      onError: () => {
        toastManager.add({ type: "error", title: "Couldn’t set up the guest profile" });
      },
    });

  return (
    <FocusScreen className="max-w-md gap-10">
      <header className="flex flex-col items-center gap-4 text-center">
        <h1 className="font-heading text-display font-stretch-semi-expanded">Sinag</h1>
        <p className="max-w-sm text-pretty text-muted-foreground">
          {server.data?.custom
            ? `Sign in with your account on ${serverName(server.data.url)} to bring your profiles, library and Continue Watching with you.`
            : "Sign in with your Nuvio account to bring your profiles, library and Continue Watching with you."}
        </p>
      </header>

      {noKeychain && (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Signing in needs a keychain</AlertTitle>
          <AlertDescription>{noKeychain}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3">
        {noKeychain ? (
          <Button size="lg" className={pillButton} disabled>
            <Mail />
            Sign in with email
          </Button>
        ) : (
          <Link to="/sign-in" className={cn(buttonVariants({ size: "lg" }), pillButton)}>
            <Mail />
            Sign in with email
          </Link>
        )}
        {/* QR sign-in (#21): approve on the phone, no password typed here.
            Nuvio's server only. */}
        {server.data?.custom ? null : noKeychain ? (
          <Button size="lg" variant="ghost" className={cn(pillButton, glassButton)} disabled>
            <QrCode />
            Sign in with your phone
          </Button>
        ) : (
          <Link
            to="/qr-sign-in"
            className={cn(
              buttonVariants({ size: "lg", variant: "ghost" }),
              pillButton,
              glassButton,
            )}
          >
            <QrCode />
            Sign in with your phone
          </Link>
        )}
        <Button
          size="lg"
          variant="ghost"
          className={cn(pillButton, glassButton)}
          loading={guest.isPending}
          onClick={continueAsGuest}
        >
          Continue as guest
        </Button>
      </div>

      <div className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p className="flex gap-2">
          <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
          As a guest, your addons, library and progress stay on this device. You can sign in later
          from the profile menu or Settings, and the Guest profile stays as it is.
        </p>
        {/* Before anything else, what Sinag is (#39). Settings › About repeats it. */}
        <p className="flex gap-2">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {contentDisclaimer}
        </p>
      </div>
    </FocusScreen>
  );
}
