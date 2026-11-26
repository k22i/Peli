import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SettingRow } from "@/components/settings/settings-section";
import { RestartDialog } from "@/components/shell/update-status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { feature } from "@/lib/features";
import { deviceSettingsQuery, useSaveDeviceSettings } from "@/lib/settings";
import {
  readyVersion,
  updateSummary,
  UpdateState,
  useCheckForUpdates,
  useUpdateStatus,
} from "@/lib/updates";

// Settings › About's update rows (#83): where the updater is, "Check now" or
// "Restart to update", and whether it looks by itself.
export function UpdateRows() {
  // App Store updates on iOS (ADR-0055).
  if (!feature("updates")) return null;
  return <UpdateRowsOnDesktop />;
}

function UpdateRowsOnDesktop() {
  const status = useUpdateStatus();
  const check = useCheckForUpdates();
  const [restarting, setRestarting] = useState(false);
  const version = readyVersion(status);
  const off = !status || status.state === UpdateState.Off;
  const busy = status?.state === UpdateState.Checking || status?.state === UpdateState.Downloading;

  return (
    <>
      <SettingRow
        id="updates"
        label="Updates"
        description={<output>{updateSummary(status)}</output>}
      >
        {version ? (
          <>
            <Button size="sm" onClick={() => setRestarting(true)}>
              Restart to update
            </Button>
            <RestartDialog version={version} open={restarting} onOpenChange={setRestarting} />
          </>
        ) : (
          !off && (
            <Button
              variant="outline"
              size="sm"
              aria-describedby="updates-description"
              loading={busy || check.isPending}
              onClick={() => check.mutate()}
            >
              Check now
            </Button>
          )
        )}
      </SettingRow>
      {!off && <AutoUpdateRow />}
    </>
  );
}

function AutoUpdateRow() {
  const device = useQuery(deviceSettingsQuery).data;
  const save = useSaveDeviceSettings();
  return (
    <SettingRow
      id="auto-update"
      label="Automatic updates"
      description="Checks for and downloads new versions in the background. Asks before restarting. This device."
    >
      <Switch
        aria-labelledby="auto-update-label"
        aria-describedby="auto-update-description"
        disabled={!device}
        checked={device?.autoUpdate ?? true}
        onCheckedChange={(autoUpdate) => device && save.mutate({ ...device, autoUpdate })}
      />
    </SettingRow>
  );
}
