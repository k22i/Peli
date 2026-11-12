import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Events } from "@wailsio/runtime";
import { useEffect, useRef } from "react";

import { toastManager } from "@/components/ui/toast";
import { feature } from "@/lib/features";
import { Reason, Service as Updates, State, type Status } from "@bindings/updates";

// Updates (#83, ADR-0054): internal/updates looks for a new release by
// itself, downloads it and checks its signature, then says it's ready. It
// installs only when the user restarts Peli, and Go refuses to restart while
// something is playing.

export { Reason as UpdateReason, State as UpdateState };
export type UpdateStatus = Status;

// Sent by internal/updates whenever the status changes, with the Status.
export const updateStatusEvent = "updates:status";

export const updateStatusQuery = queryOptions({
  queryKey: ["updates", "status"],
  queryFn: () => Updates.Status(),
  // Not bound on iOS: App Store updates (ADR-0055).
  enabled: () => feature("updates"),
  staleTime: Number.POSITIVE_INFINITY,
});

// Keeps the status as Go sends it. Mounted once, at the root.
export function useUpdateEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!feature("updates")) return undefined;
    return Events.On(updateStatusEvent, (event) => {
      queryClient.setQueryData(updateStatusQuery.queryKey, event.data);
    });
  }, [queryClient]);
}

export function useUpdateStatus(): Status | undefined {
  return useQuery(updateStatusQuery).data;
}

// The version ready to install, if there is one.
export function readyVersion(status: Status | undefined): string | undefined {
  return status?.state === State.Ready ? status.version : undefined;
}

// The code updates.MarshalError put in a call's cause.
export function updateErrorCode(error: unknown): string | undefined {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return typeof code === "string" ? code : undefined;
}

// "Check now": Go answers at once and the status events say how it goes.
export function useCheckForUpdates() {
  return useMutation({ mutationFn: () => Updates.Check() });
}

// "Restart to update": Peli quits, the new version goes in its place and
// opens. The window closes, so success needs nothing more.
export function useRestartToUpdate() {
  return useMutation({
    mutationFn: () => Updates.Restart(),
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Couldn’t restart Peli",
        description:
          updateErrorCode(error) === "playing"
            ? "Stop what’s playing first."
            : "Try again, or quit Peli and open it again.",
      });
    },
  });
}

// What Settings › About says about updates, in a sentence.
export function updateSummary(status: Status | undefined): string {
  if (!status) return "…";
  switch (status.state) {
    case State.Off:
      switch (status.reason) {
        case Reason.Development:
          return "Development builds don’t update.";
        case Reason.NotInstalled:
          return "Move Peli to your Applications folder to get updates.";
        case Reason.ReadOnly:
          return "Peli can’t replace itself in the folder it’s in. Download new versions instead.";
        default:
          return "Updates aren’t available on this computer yet.";
      }
    case State.Checking:
      return "Checking for updates…";
    case State.UpToDate:
      return "Peli is up to date.";
    case State.Downloading: {
      const total = status.total ?? 0;
      const percent = total > 0 ? Math.floor(((status.written ?? 0) / total) * 100) : 0;
      return `Downloading Peli ${status.version ?? ""}… ${percent} %`;
    }
    case State.Ready:
      return `Peli ${status.version ?? ""} is ready. It installs when you restart Peli.`;
    case State.Failed:
      return status.problem ?? "The last check didn’t work. Peli tries again later.";
    default:
      return "Peli checks for updates in the background.";
  }
}

// Says once per version that an update is ready, unless something is
// playing: then it waits until the player is closed.
export function useUpdateReadyToast(playing: boolean) {
  const version = readyVersion(useUpdateStatus());
  const { mutate: restart } = useRestartToUpdate();
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!version || playing || shown.current === version) return;
    shown.current = version;
    toastManager.add({
      type: "info",
      title: `Peli ${version} is ready`,
      description: "It installs when you restart Peli.",
      actionProps: { children: "Restart", onClick: () => restart() },
    });
  }, [version, playing, restart]);
}
