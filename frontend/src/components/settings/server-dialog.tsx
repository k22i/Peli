import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleCheck, LogOut, TriangleAlert } from "lucide-react";
import { useState } from "react";

import type { Server } from "@bindings/account";
import { parentSteps, usePinSteps } from "@/components/account/pin-dialog";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toastManager } from "@/components/ui/toast";
import { profilesQuery } from "@/lib/account";
import { useCurrentProfile } from "@/lib/profile";
import { thisDevice } from "@/lib/platform";
import {
  serverName,
  serverProblem,
  useSetServer,
  useTestServer,
  type ServerInput,
} from "@/lib/server";

// Picks the server Peli signs in to (#34): Nuvio's, or the user's own
// Nuvio-compatible one. Switching to another server signs out first.
export function ServerDialog({
  server,
  open,
  onOpenChange,
}: {
  server: Server;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        {/* A fresh form each time it opens. */}
        {open && <ServerForm server={server} onDone={() => onOpenChange(false)} />}
      </DialogPopup>
    </Dialog>
  );
}

function ServerForm({ server, onDone }: { server: Server; onDone: () => void }) {
  const navigate = useNavigate();
  const current = useCurrentProfile();
  const profiles = useQuery(profilesQuery);
  const { ask, dialog } = usePinSteps();
  const test = useTestServer();
  const set = useSetServer();

  const [own, setOwn] = useState(server.custom);
  const [url, setUrl] = useState(server.custom ? server.url : "");
  const [key, setKey] = useState("");
  const input: ServerInput = own ? { url, key } : { url: "", key: "" };
  // What was last tested or saved: its result shows while the fields still
  // say the same.
  const [checked, setChecked] = useState<ServerInput>();
  const checkedNow = checked?.url === input.url && checked.key === input.key;

  // Another server means signing out; a new key for the same one doesn't.
  const sameServer = own ? server.custom && sameURL(url, server.url) : !server.custom;
  const hasAccount = profiles.data?.some((p) => p.nuvioIndex != null) === true;
  const signsOut = !sameServer && (current.signedIn || hasAccount);

  const error = checkedNow ? (set.error ?? test.error) : null;
  const problem = error ? serverProblem(error) : undefined;

  const runTest = () => {
    set.reset();
    setChecked(input);
    test.mutate(input);
  };

  const switchNow = () =>
    set.mutate(input, {
      onSuccess: (saved) => {
        onDone();
        toastManager.add({
          type: "success",
          title: saved.custom ? `Using ${serverName(saved.url)}` : "Using Nuvio’s server",
        });
        // Home, or the welcome screen if no profiles are left.
        if (!sameServer) void navigate({ to: "/" });
      },
    });

  const submit = () => {
    test.reset();
    setChecked(input);
    // Leaving a kids profile asks for the parent PIN (#26).
    ask(signsOut ? parentSteps(current) : [], switchNow);
  };

  return (
    <>
      <Form
        className="contents"
        errors={problem?.field ? { [problem.field]: problem.title } : {}}
        onFormSubmit={submit}
      >
        <DialogHeader>
          <DialogTitle>Server</DialogTitle>
          <DialogDescription>
            Peli syncs through Nuvio’s server, or through your own Nuvio-compatible server, such as
            one you host yourself.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          <RadioGroup
            aria-label="Server"
            value={own ? "own" : "nuvio"}
            onValueChange={(value) => setOwn(value === "own")}
          >
            <div className="flex items-center gap-2.5">
              <RadioGroupItem id="server-nuvio" value="nuvio" />
              <label htmlFor="server-nuvio" className="text-body">
                Nuvio’s server
              </label>
            </div>
            <div className="flex items-center gap-2.5">
              <RadioGroupItem id="server-own" value="own" />
              <label htmlFor="server-own" className="text-body">
                My own server
              </label>
            </div>
          </RadioGroup>

          {own && (
            <>
              <Field name="url" className="items-stretch">
                <FieldLabel>Address</FieldLabel>
                <Input
                  type="url"
                  required
                  value={url}
                  onValueChange={setUrl}
                  placeholder="https://nuvio.example.com"
                  autoComplete="url"
                  spellCheck={false}
                  autoCapitalize="none"
                  // oxlint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
                <FieldError />
              </Field>
              <Field name="key" className="items-stretch">
                <FieldLabel>Publishable key (optional)</FieldLabel>
                <Input
                  type="password"
                  value={key}
                  onValueChange={setKey}
                  autoComplete="off"
                  spellCheck={false}
                />
                <FieldError />
                <FieldDescription>
                  {server.custom && server.hasKey
                    ? "A key is saved for this server. Enter it again to keep it; left empty, the key the server publishes is used. "
                    : "Leave it empty if the server publishes its key, as NuvioMedia/self-host does. "}
                  Kept in {thisDevice()}’s keychain.
                </FieldDescription>
              </Field>
            </>
          )}

          {problem && (
            <Alert variant="error">
              <TriangleAlert />
              <AlertTitle>{problem.title}</AlertTitle>
              <AlertDescription>{problem.description}</AlertDescription>
            </Alert>
          )}
          {checkedNow && test.isSuccess && (
            <Alert variant="success">
              <CircleCheck />
              <AlertTitle>Connected</AlertTitle>
              <AlertDescription>{serverName(url)} answers as a Nuvio server.</AlertDescription>
            </Alert>
          )}
          {signsOut && (
            <Alert variant="warning">
              <LogOut />
              <AlertTitle>Switching signs you out</AlertTitle>
              <AlertDescription>
                Your Nuvio profiles are removed from {thisDevice()}, with their library and progress.
                Changes waiting to sync are sent first. The Guest profile stays. Then sign in with
                an account on the new server.
              </AlertDescription>
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          {own && (
            <Button
              type="button"
              variant="outline"
              className="sm:me-auto"
              loading={test.isPending}
              disabled={url.trim() === ""}
              onClick={runTest}
            >
              Test connection
            </Button>
          )}
          <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
          <Button type="submit" loading={set.isPending}>
            {signsOut ? "Sign out and switch" : sameServer ? "Save" : "Switch"}
          </Button>
        </DialogFooter>
      </Form>
      {dialog}
    </>
  );
}

// Whether two server addresses are the same, as Go compares them (without a
// trailing slash, host in lowercase).
function sameURL(a: string, b: string): boolean {
  return normalURL(a) === normalURL(b);
}

function normalURL(s: string): string {
  try {
    const u = new URL(s.trim());
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return s.trim();
  }
}
