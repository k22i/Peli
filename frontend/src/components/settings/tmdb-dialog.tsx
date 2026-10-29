import { TriangleAlert } from "lucide-react";
import { useState } from "react";

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
import { toastManager } from "@/components/ui/toast";
import { TmdbError, useRemoveTmdbKey, useSaveTmdbKey } from "@/lib/tmdb";

// TMDB's terms ask apps that use its API to say so.
export const tmdbNotice =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";

// Adds, changes or removes the optional TMDB key (#47). The key is checked
// with TMDB before it's saved to the keychain, and never shown again.
export function TmdbDialog({
  hasKey,
  open,
  onOpenChange,
}: {
  hasKey: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        {/* A fresh form each time it opens. */}
        {open && <TmdbForm hasKey={hasKey} onDone={() => onOpenChange(false)} />}
      </DialogPopup>
    </Dialog>
  );
}

function TmdbForm({ hasKey, onDone }: { hasKey: boolean; onDone: () => void }) {
  const save = useSaveTmdbKey();
  const remove = useRemoveTmdbKey();
  const [key, setKey] = useState("");
  // What was last saved: its error shows while the field still says it.
  const [tried, setTried] = useState<string>();
  const error = tried === key.trim() ? (save.error ?? remove.error) : null;
  const problem = error ? tmdbProblem(error) : undefined;

  const submit = () => {
    remove.reset();
    const trimmed = key.trim();
    setTried(trimmed);
    save.mutate(trimmed, {
      onSuccess: () => {
        onDone();
        toastManager.add({ type: "success", title: "TMDB key saved" });
      },
    });
  };

  const removeKey = () => {
    save.reset();
    setTried(key.trim());
    remove.mutate(undefined, {
      onSuccess: () => {
        onDone();
        toastManager.add({ type: "success", title: "TMDB key removed" });
      },
    });
  };

  return (
    <Form
      className="contents"
      errors={problem?.field ? { key: problem.title } : {}}
      onFormSubmit={submit}
    >
      <DialogHeader>
        <DialogTitle>TMDB</DialogTitle>
        <DialogDescription>
          With your own TMDB key, title pages show TMDB’s logos, backdrops and cast photos. Without
          one, they show what your addons send.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        <Field name="key" className="items-stretch">
          <FieldLabel>API key or read access token</FieldLabel>
          <Input
            type="password"
            required
            value={key}
            onValueChange={setKey}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
          <FieldError />
          <FieldDescription>
            {hasKey ? "A key is saved. Enter a new one to replace it. " : ""}
            Get one free from your account’s API settings on themoviedb.org. Kept in this computer’s
            keychain.
          </FieldDescription>
        </Field>
        {problem && !problem.field && (
          <Alert variant="error">
            <TriangleAlert />
            <AlertTitle>{problem.title}</AlertTitle>
            <AlertDescription>{problem.description}</AlertDescription>
          </Alert>
        )}
        <p className="text-sm text-muted-foreground">{tmdbNotice}</p>
      </DialogPanel>
      <DialogFooter>
        {hasKey && (
          <Button
            type="button"
            variant="destructive-outline"
            className="sm:me-auto"
            loading={remove.isPending}
            onClick={removeKey}
          >
            Remove key
          </Button>
        )}
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
      </DialogFooter>
    </Form>
  );
}

type TmdbProblem = { field?: "key"; title: string; description?: string };

// What to tell the user when saving or removing the key fails.
function tmdbProblem(error: Error): TmdbProblem {
  if (!(error instanceof TmdbError)) {
    // From the keychain: what to install, on Linux without a Secret Service.
    return { title: "Couldn’t keep the key in the keychain", description: error.message };
  }
  switch (error.kind) {
    case "invalid_key":
      return { field: "key", title: error.message };
    case "key_refused":
      return { field: "key", title: "TMDB refused the key. Check it and paste it again." };
    case "unreachable":
      return {
        title: "Can’t reach TMDB",
        description: "Check your connection. The key is checked with TMDB before it’s saved.",
      };
    default:
      return { title: "TMDB isn’t answering", description: "Try again in a minute." };
  }
}
