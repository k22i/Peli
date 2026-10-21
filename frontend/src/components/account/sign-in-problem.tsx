import {
  CloudOff,
  Lock,
  ServerCrash,
  Timer,
  TimerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { signInErrorCode, type SignInErrorCode } from "@/lib/account";

export type Problem = { icon: LucideIcon; title: string; description: string };

// What a failed sign-in tells the user, by email (#20) or QR code (#21). A
// wrong password goes under the password field instead.
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
  parent_pin_required: {
    icon: Lock,
    title: "A kids profile is in use",
    description: "Switch to a parent profile first, with the parent PIN, then sign in.",
  },
  qr_expired: {
    icon: TimerOff,
    title: "The code expired",
    description: "Codes last five minutes. Get a new one and scan it again.",
  },
};

export function problemFor(error: Error): Problem {
  const code = signInErrorCode(error);
  const problem = code && code !== "invalid_credentials" ? problems[code] : undefined;
  if (!problem)
    return { icon: TriangleAlert, title: "Couldn’t sign in", description: error.message };
  // The keychain error says what to install.
  return problem.description ? problem : { ...problem, description: error.message };
}

export function SignInProblem({ problem, action }: { problem: Problem; action?: ReactNode }) {
  return (
    <Alert variant="error">
      <problem.icon />
      <AlertTitle>{problem.title}</AlertTitle>
      <AlertDescription>{problem.description}</AlertDescription>
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  );
}
