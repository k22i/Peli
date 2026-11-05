import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, LogIn, LockKeyhole, QrCode } from "lucide-react";
import { useEffect, useState } from "react";

import { FocusScreen } from "@/components/account/focus-screen";
import { SignInProblem, problemFor, type Problem } from "@/components/account/sign-in-problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import {
  keychainQuery,
  needsPicker,
  profilesQuery,
  signInErrorCode,
  useSignIn,
} from "@/lib/account";
import { serverName, serverQuery } from "@/lib/server";
import { cn } from "@/lib/utils";

type SignInSearch = {
  // Why the app sent the user here: their session ended (#22).
  reason?: "session-ended";
};

export const Route = createFileRoute("/sign-in")({
  staticData: { chrome: "focus" },
  validateSearch: (search: Record<string, unknown>): SignInSearch =>
    search["reason"] === "session-ended" ? { reason: "session-ended" } : {},
  component: SignIn,
});

// Fields and buttons in the card are a little taller and rounder than the
// defaults. The input's height sits on the inner <input>.
const fieldClass = "rounded-xl [&_input]:h-11 [&_input]:text-base [&_input]:leading-11";

// Nuvio allows 10 sign-in attempts a second and says nothing about when to
// retry (no Retry-After), so after a 429 the form waits this long.
const rateLimitCooldown = 10;

// Email and password sign-in (#20). Go keeps the session in the keychain;
// this page never sees a token.
function SignIn() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const sessionEnded = Route.useSearch().reason === "session-ended";
  const profiles = useQuery(profilesQuery);
  // Read from the list: asking for the current profile would make a Guest.
  const hasGuest = profiles.data?.some((profile) => profile.guest) === true;
  const keychain = useQuery(keychainQuery);
  // The user's own server (#34): its accounts, and no phone sign-in.
  const server = useQuery(serverQuery);
  const own = server.data?.custom === true ? serverName(server.data.url) : undefined;
  const signIn = useSignIn();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Problem>();
  const cooldown = useCountdown();

  // Back to where the user came from: Settings, or the welcome screen on
  // first run.
  const firstRun = profiles.data?.length === 0;
  const back = () => {
    // The app sent the user here, so "Not now" carries on into it.
    if (sessionEnded) void navigate({ to: "/" });
    else if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: firstRun ? "/welcome" : "/settings" });
  };

  const submit = (values: Record<string, unknown>) => {
    const { email, password } = values;
    if (typeof email !== "string" || typeof password !== "string") return;
    setErrors({});
    setProblem(undefined);
    signIn.mutate(
      { email, password },
      {
        onSuccess: (profile) => {
          // With more than one profile, the picker asks which (#24).
          if (needsPicker(queryClient.getQueryData(profilesQuery.queryKey))) {
            toastManager.add({ type: "success", title: "Signed in to Nuvio" });
            // Replaced, so Back doesn't return to the form.
            void navigate({ to: "/profiles", replace: true });
            return;
          }
          toastManager.add({ type: "success", title: `Signed in as ${profile.name}` });
          void navigate({ to: "/" });
        },
        onError: (error) => {
          const code = signInErrorCode(error);
          if (code === "invalid_credentials") {
            setErrors({
              password: own
                ? `That email and password don’t match an account on ${own}.`
                : "That email and password don’t match a Nuvio account.",
            });
            return;
          }
          if (code === "rate_limited") cooldown.start(rateLimitCooldown);
          setProblem(problemFor(error));
        },
      },
    );
  };

  return (
    <FocusScreen className="max-w-md">
      <Button variant="ghost" size="sm" className="-ms-2.5 self-start" onClick={back}>
        <ArrowLeft />
        {sessionEnded ? "Not now" : "Back"}
      </Button>

      <div className="flex flex-col gap-8 glass-thick rounded-3xl p-8">
        <header className="flex flex-col gap-2">
          <h1 className="font-heading text-title font-stretch-semi-expanded">
            {own ? "Sign in to your server" : "Sign in to Nuvio"}
          </h1>
          <p className="text-pretty text-muted-foreground">
            {own
              ? `Use the email and password of your account on ${own}.`
              : "Use the email and password of your Nuvio account."}
            {hasGuest &&
              " Your Guest profile stays on this computer as it is, apart from your Nuvio profiles."}
          </p>
        </header>

        {sessionEnded && (
          <Alert variant="info">
            <LogIn />
            <AlertTitle>Your Nuvio session ended</AlertTitle>
            <AlertDescription>
              You were signed out on another device, or the session expired. Sign in again to keep
              syncing. Your library and progress on this computer are kept.
            </AlertDescription>
          </Alert>
        )}

        <Form className="flex flex-col gap-5" errors={errors} onFormSubmit={submit}>
          <Field name="email" className="items-stretch">
            <FieldLabel>Email</FieldLabel>
            <Input
              type="email"
              required
              autoComplete="username"
              spellCheck={false}
              autoCapitalize="none"
              className={fieldClass}
            />
            <FieldError />
          </Field>
          <Field name="password" className="items-stretch">
            <FieldLabel>Password</FieldLabel>
            <Input
              type="password"
              required
              autoComplete="current-password"
              className={fieldClass}
            />
            <FieldError />
          </Field>

          {problem && <SignInProblem problem={problem} />}

          <Button
            type="submit"
            size="lg"
            className="h-11 w-full rounded-xl text-base before:rounded-[calc(var(--radius-xl)-1px)] sm:h-11 sm:text-base"
            loading={signIn.isPending}
            disabled={cooldown.seconds > 0 || keychain.data != null}
          >
            {cooldown.seconds > 0 ? `Try again in ${cooldown.seconds} s` : "Sign in"}
          </Button>
        </Form>

        {keychain.data == null && !own && (
          <Link
            to="/qr-sign-in"
            replace
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "h-11 rounded-xl text-base before:rounded-[calc(var(--radius-xl)-1px)] sm:h-11 sm:text-base",
            )}
          >
            <QrCode />
            Sign in with your phone instead
          </Link>
        )}

        <p className="flex gap-2 text-sm text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden />
          Sinag doesn’t keep your password. Your session is stored in this computer’s keychain.
        </p>
      </div>
    </FocusScreen>
  );
}

// A countdown in whole seconds, for the rate-limit cooldown.
function useCountdown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = seconds > 0 ? setTimeout(() => setSeconds((s) => s - 1), 1000) : undefined;
    return () => clearTimeout(timer);
  }, [seconds]);
  return { seconds, start: setSeconds };
}
