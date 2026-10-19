import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  CloudOff,
  LogIn,
  LockKeyhole,
  ServerCrash,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import {
  keychainQuery,
  profilesQuery,
  signInErrorCode,
  useSignIn,
  type SignInErrorCode,
} from "@/lib/account";

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

// Nuvio allows 10 sign-in attempts a second and says nothing about when to
// retry (no Retry-After), so after a 429 the form waits this long.
const rateLimitCooldown = 10;

type Problem = { icon: LucideIcon; title: string; description: string };

// What a failed sign-in tells the user. A wrong password goes under the
// password field instead.
const problems: Record<Exclude<SignInErrorCode, "invalid_credentials">, Problem> = {
  rate_limited: {
    icon: Timer,
    title: "Too many attempts",
    description: "Nuvio is limiting sign-ins for a moment. Wait a few seconds, then try again.",
  },
  unreachable: {
    icon: CloudOff,
    title: "Can’t reach Nuvio",
    description: "Check your internet connection, then try again.",
  },
  unavailable: {
    icon: ServerCrash,
    title: "Nuvio isn’t responding",
    description: "Its servers returned an error. Try again in a minute.",
  },
  keychain_unavailable: {
    icon: TriangleAlert,
    title: "Signing in needs a keychain",
    description: "",
  },
};

function problemFor(error: Error): Problem {
  const code = signInErrorCode(error);
  const problem = code && code !== "invalid_credentials" ? problems[code] : undefined;
  if (!problem)
    return { icon: TriangleAlert, title: "Couldn’t sign in", description: error.message };
  // The keychain error says what to install.
  return problem.description ? problem : { ...problem, description: error.message };
}

// Email and password sign-in (#20). Go keeps the session in the keychain;
// this page never sees a token.
function SignIn() {
  const navigate = useNavigate();
  const router = useRouter();
  const sessionEnded = Route.useSearch().reason === "session-ended";
  const profiles = useQuery(profilesQuery);
  const keychain = useQuery(keychainQuery);
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
          toastManager.add({ type: "success", title: `Signed in as ${profile.name}` });
          void navigate({ to: "/" });
        },
        onError: (error) => {
          const code = signInErrorCode(error);
          if (code === "invalid_credentials") {
            setErrors({ password: "That email and password don’t match a Nuvio account." });
            return;
          }
          if (code === "rate_limited") cooldown.start(rateLimitCooldown);
          setProblem(problemFor(error));
        },
      },
    );
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-8 px-6 py-12">
      <Button variant="ghost" size="sm" className="-ms-2.5 self-start" onClick={back}>
        <ArrowLeft />
        {sessionEnded ? "Not now" : "Back"}
      </Button>

      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-title font-stretch-semi-expanded">Sign in to Nuvio</h1>
        <p className="text-pretty text-muted-foreground">
          Use the email and password of your Nuvio account.
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
          />
          <FieldError />
        </Field>
        <Field name="password" className="items-stretch">
          <FieldLabel>Password</FieldLabel>
          <Input type="password" required autoComplete="current-password" />
          <FieldError />
        </Field>

        {problem && (
          <Alert variant="error">
            <problem.icon />
            <AlertTitle>{problem.title}</AlertTitle>
            <AlertDescription>{problem.description}</AlertDescription>
          </Alert>
        )}

        <Button
          type="submit"
          size="lg"
          loading={signIn.isPending}
          disabled={cooldown.seconds > 0 || keychain.data != null}
        >
          {cooldown.seconds > 0 ? `Try again in ${cooldown.seconds} s` : "Sign in"}
        </Button>
      </Form>

      <p className="flex gap-2 text-sm text-muted-foreground">
        <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden />
        Sinag doesn’t keep your password. Your session is stored in this computer’s keychain.
      </p>
    </div>
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
