import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { House, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { FocusScreen, glassButton, pillButton } from "@/components/account/focus-screen";
import { Button } from "@/components/ui/button";
import { reportError } from "@/lib/diagnostics";
import { cn } from "@/lib/utils";

// What a page that failed to render shows instead of nothing (#127): the
// router's errorComponent, at the root and for every route. The message is
// there for a screenshot; the stack goes to Go's log, not the screen.
export function ErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  useEffect(() => {
    reportError("render", error);
  }, [error]);

  const message = error instanceof Error ? error.message : String(error);

  const goHome = () => {
    void router.navigate({ to: "/" }).then(() => reset());
  };

  return (
    <FocusScreen className="max-w-md items-center gap-8 text-center">
      <header className="flex flex-col items-center gap-4">
        <TriangleAlert className="size-10 text-sun" aria-hidden />
        <h1 className="font-display text-[2.5rem] leading-none tracking-[-0.01em]">
          Something went wrong
        </h1>
        <p className="max-w-sm text-[0.9375rem] text-pretty text-muted-foreground">
          Peli couldn’t show this page. Reloading usually fixes it.
        </p>
      </header>

      <div className="flex w-full flex-col gap-3">
        <Button
          size="lg"
          variant="sun"
          className={pillButton}
          onClick={() => window.location.reload()}
        >
          <RotateCw />
          Reload
        </Button>
        <Button size="lg" variant="ghost" className={cn(pillButton, glassButton)} onClick={goHome}>
          <House />
          Go Home
        </Button>
      </div>

      {message && (
        <details className="w-full rounded-xl bg-foreground/5 px-4 py-3 text-start text-small text-muted-foreground">
          <summary className="cursor-default font-medium text-foreground">Details</summary>
          <p className="mt-2 font-mono text-xs break-words">{message}</p>
        </details>
      )}
    </FocusScreen>
  );
}
