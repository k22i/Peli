import { CloudOff, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { isTouch } from "@/lib/platform";
import { useCheckConnection, useConnection } from "@/lib/sync";
import { Connection } from "@bindings/syncer";

const copy: Partial<Record<Connection, { label: string; detail: string }>> = {
  [Connection.Offline]: {
    label: "Offline",
    detail: "Showing what's saved on this device. Changes sync when you're back online.",
  },
  [Connection.Unavailable]: {
    label: "Nuvio is down",
    detail: "Nuvio isn't responding. Changes are saved here and sync when it's back.",
  },
};

// A quiet pill beside the profile menu while Nuvio can't be reached (#31). It
// never blocks anything: the library and Continue Watching come from the
// local store, and changes wait to be sent. Clicking it checks again; Go
// also checks by itself and when the network comes back.
export function ConnectionStatus() {
  const connection = useConnection();
  const check = useCheckConnection();
  const [checking, setChecking] = useState(false);
  const text = copy[connection];

  return (
    // Announced when it appears, without moving focus.
    <output className="block">
      {text && (
        <Tooltip>
          <TooltipTrigger
            delay={300}
            render={
              <button
                type="button"
                disabled={checking}
                aria-label={`${text.label}. ${text.detail} Try again`}
                onClick={() => {
                  setChecking(true);
                  void check().finally(() => setChecking(false));
                }}
                className="group/status flex h-7 items-center gap-1.5 rounded-full bg-warning/14 px-2.5 text-small font-[590] text-warning-foreground outline-none transition-colors hover:bg-warning/22 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress [&_svg]:size-3.5 [&_svg]:shrink-0"
              />
            }
          >
            {checking ? (
              <RefreshCw aria-hidden className="motion-safe:animate-spin" />
            ) : (
              <>
                <CloudOff aria-hidden className="group-hover/status:hidden" />
                <RefreshCw aria-hidden className="hidden group-hover/status:block" />
              </>
            )}
            <span aria-hidden className="hidden truncate lg:inline">
              {text.label}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="bottom" className="max-w-64">
            {text.detail} {isTouch() ? "Tap" : "Click"} to try again.
          </TooltipPopup>
        </Tooltip>
      )}
    </output>
  );
}
