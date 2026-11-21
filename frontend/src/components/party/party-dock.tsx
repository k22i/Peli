import { useQuery } from "@tanstack/react-query";
import { PinOff, X } from "lucide-react";

import { PartyChat } from "@/components/party/party-chat";
import { PartyPanel } from "@/components/party/party-panel";
import { Button } from "@/components/ui/button";
import { useParty } from "@/lib/party";
import { deviceSettingsQuery, useSaveDeviceSettings } from "@/lib/settings";
import { useCompactShell } from "@/lib/shell-mode";

// The room the dock takes from the picture while it is open; the player sets
// --party-dock-w and Player.SetVideoInset from it, so the video moves left
// instead of being covered (player-page.tsx).
export const partyDockWidth = "22rem";

// Whether the party panel stays open beside the video instead of over it
// (ADR-0051's dock). The choice is the device's (DeviceSettings.PartyDock),
// saved like the other device toggles, so the next video opens with it too.
// The compact iOS shell has no room for it: its party is the bottom sheet
// (#134, ADR-0063) and the option doesn't show.
export function usePartyDock(): {
  docked: boolean;
  setDocked: (on: boolean) => void;
  available: boolean;
} {
  const available = !useCompactShell();
  const device = useQuery(deviceSettingsQuery).data;
  const save = useSaveDeviceSettings();
  return {
    available,
    // Not available, not docked: the setting stays as it is for the device
    // that can show it again.
    docked: available && (device?.partyDock ?? false),
    setDocked: (on) => {
      // Before the device's settings load there is nothing to save onto.
      if (device) save.mutate({ ...device, partyDock: on });
    },
  };
}

// The watch party as a sidebar on the right: the people and the chat, open
// while the video plays. No backdrop and no dimming, and it doesn't trap
// focus or close on an outside click: the player stays usable (the point of
// the dock). Undocking leaves the party open, so the player shows the sheet
// again; closing hides the panel and the setting stays. canShare comes from
// the player like the sheet's, so the host's "Share my stream" is only offered
// when the playing source can be shared.
export function PartyDock({ onClose, canShare }: { onClose: () => void; canShare?: boolean }) {
  const { setDocked } = usePartyDock();
  const party = useParty()?.party ?? undefined;
  return (
    <aside
      aria-label="Watch party"
      data-slot="party-dock"
      // The player is white-on-dark: the dock is too, as the sheet is.
      className="material-bar dark flex h-full w-[22rem] flex-col overflow-hidden border-s border-white/10 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground"
    >
      <header className="flex shrink-0 items-center gap-1 py-2 ps-4 pe-2">
        <h2 className="min-w-0 flex-1 truncate text-body font-[650]">Watch party</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Undock"
          title="Undock"
          onClick={() => setDocked(false)}
        >
          <PinOff />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </header>
      {party ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4">
          {/* The people and the party's controls, up to a little under half
              the dock: the chat keeps the rest of the height. */}
          <div className="max-h-[45%] min-h-0 shrink-0 overflow-y-auto overscroll-contain pt-1">
            <PartyPanel party={party} canShare={canShare} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-white/10 pt-3">
            <PartyChat />
          </div>
        </div>
      ) : (
        <p className="px-4 pb-4 text-small text-muted-foreground">
          Nobody’s in a party. Press W to start one or join with a code.
        </p>
      )}
    </aside>
  );
}
