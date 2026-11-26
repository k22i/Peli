import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SettingRow } from "@/components/settings/settings-section";
import { RestartDialog } from "@/components/shell/update-status";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { feature } from "@/lib/features";
import { deviceSettingsQuery, useSaveDeviceSettings } from "@/lib/settings";
import {
  foundVersion,
  readyVersion,
  updateSummary,
  UpdateState,
  useCheckForUpdates,
  useDownloadUpdate,
  useUpdateStatus,
} from "@/lib/updates";

// Settings › About's update rows (#83): where the updater is, "Check now",
// "Download" or "Restart to update", and whether it looks by itself.
export function UpdateRows() {
  // App Store updates on iOS (ADR-0055).
  if (!feature("updates")) return null;
  return <UpdateRowsOnDesktop />;
}

function UpdateRowsOnDesktop() {
  const status = useUpdateStatus();
  const check = useCheckForUpdates();
  const download = useDownloadUpdate();
  const [restarting, setRestarting] = useState(false);
  // The release the user said "Not now" to, so a check doesn't ask twice.
  const [later, setLater] = useState<string>();
  const version = readyVersion(status);
  const found = foundVersion(status);
  const off = !status || status.state === UpdateState.Off;
  const busy =
    status?.state === UpdateState.Checking ||
    status?.state === UpdateState.Downloading ||
    check.isPending;
  // A check asks before it downloads: the dialog is the question.
  const asking = found !== undefined && found !== later;

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
        ) : found ? (
          <Button
            size="sm"
            aria-describedby="updates-description"
            loading={download.isPending}
            onClick={() => download.mutate()}
          >
            Download
          </Button>
        ) : (
          !off && (
            <Button
              variant="outline"
              size="sm"
              aria-describedby="updates-description"
              loading={busy}
              onClick={() => {
                setLater(undefined);
                check.mutate();
              }}
            >
              Check now
            </Button>
          )
        )}
      </SettingRow>
      {found && (
        <DownloadDialog
          version={found}
          open={asking}
          onOpenChange={(open) => {
            if (!open) setLater(found);
          }}
        />
      )}
      {!off && <AutoUpdateRow />}
    </>
  );
}

// The question a manual check asks (#83): "Check now" finds the release,
// this asks whether to download it. Nothing downloads until it's answered
// yes, and "Not now" leaves the Download button in the row.
function DownloadDialog({
  version,
  open,
  onOpenChange,
}: {
  version: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const download = useDownloadUpdate();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Download Peli {version}?</AlertDialogTitle>
          <AlertDialogDescription>
            Peli {version} is available. It downloads in the background and is ready when you are;
            Peli asks before it restarts into it. Your library and settings stay as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Not now</AlertDialogClose>
          <Button loading={download.isPending} onClick={() => download.mutate()}>
            Download
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
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
