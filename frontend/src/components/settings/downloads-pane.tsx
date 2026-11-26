import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

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
import { ResponsiveSelect } from "@/components/ui/responsive-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import {
  SettingRow,
  SettingsGroup,
  SettingsPaneView,
} from "@/components/settings/settings-section";
import {
  Downloads,
  downloadErrorText,
  downloadUsageKey,
  formatBytes,
  useDownloadActions,
  useDownloadUsage,
} from "@/lib/downloads";
import { feature } from "@/lib/features";
import { errorCode } from "@/lib/party";
import { useCurrentProfile } from "@/lib/profile";
import { deviceSettingsQuery, useSaveDeviceSettings, type DeviceSettings } from "@/lib/settings";

// Settings › Downloads (#85, ADR-0064): where the files go on this device, how
// much room they may take, whether they wait for Wi-Fi, and a way to remove
// them all. Everything here is the device's, not a profile's: a download
// belongs to the profile that started it, but the folder and the cap are this
// machine's (lib/settings saves them like every other device row).
//
// Kids profiles see neither the folder nor "Delete all": Go refuses both with
// `kids_profile`, and a parent's disk is not a kid's to rearrange. They still
// download, and still see where their files are and how much room is left.

// The caps Go offers (store.DownloadCaps, internal/store/settings.go). They
// must stay in step: Go refuses a saved cap that isn't one of them.
export const downloadCaps = [10, 25, 50, 100, 250, 500] as const;

// Go's default, and the fallback for a record that predates this pane.
const defaultCap = 50;

const capOf = (saved: number | undefined): number =>
  downloadCaps.find((gb) => gb === saved) ?? defaultCap;

const capItems = downloadCaps.map((gb) => ({ value: String(gb), label: `${gb} GB` }));

export function DownloadsPane({
  title,
  profileId,
}: {
  title: string;
  profileId: number | undefined;
}) {
  const kids = useCurrentProfile().kids;
  return (
    <SettingsPaneView
      title={title}
      lead="Downloads stay on this device and play without a connection."
    >
      {profileId === undefined ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : (
        <LoadedDownloadsPane profileId={profileId} kids={kids} />
      )}
    </SettingsPaneView>
  );
}

function LoadedDownloadsPane({ profileId, kids }: { profileId: number; kids: boolean }) {
  const client = useQueryClient();
  const device = useQuery(deviceSettingsQuery).data;
  const usage = useDownloadUsage();
  const saveDevice = useSaveDeviceSettings();
  const downloads = useDownloadActions(profileId);
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!device) return <Skeleton className="h-48 rounded-2xl" />;

  // Choosing a folder saves it in Go too, and both it and the cap change what
  // the usage line says: the folder it counts, the cap against it.
  const refresh = () => {
    void client.invalidateQueries({ queryKey: deviceSettingsQuery.queryKey });
    void client.invalidateQueries({ queryKey: downloadUsageKey });
  };

  // `onSuccess` only when there is one: exactOptionalPropertyTypes, and a
  // mutation must not be handed `undefined` in its place.
  const save = (change: Partial<DeviceSettings>, after?: () => void) =>
    saveDevice.mutate({ ...device, ...change }, after ? { onSuccess: after } : {});

  // Go opens the folder dialog and saves the answer; "" is cancelled, and
  // nothing changes then.
  const chooseFolder = async () => {
    setChoosing(true);
    try {
      if ((await Downloads.ChooseFolder(profileId)) !== "") refresh();
    } catch (error) {
      toastManager.add({ type: "error", title: downloadErrorText(errorCode(error)) });
    } finally {
      setChoosing(false);
    }
  };

  const deleteAll = async () => {
    setConfirming(false);
    await downloads.removeAll();
  };

  const usageText = usage
    ? `${formatBytes(usage.used)} used · ${formatBytes(usage.free)} free on this disk`
    : undefined;
  // A part file counts towards the usage, so anything above zero is something
  // "Delete all" would remove.
  const hasDownloads = (usage?.used ?? 0) > 0;

  return (
    <>
      <SettingsGroup title="This device">
        {/* Desktop only: the phone downloads into its own sandbox, where there
        is no dialog to pick a folder (ChooseFolder is unsupported there). */}
        {feature("downloadFolder") && !kids && (
          <SettingRow
            id="downloads-folder"
            label="Location"
            description="New downloads go here; existing ones stay put."
          >
            <span className="max-w-56 truncate text-small text-muted-foreground" title={usage?.dir}>
              {usage?.dir ?? "…"}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!usage || choosing}
              onClick={chooseFolder}
            >
              Change…
            </Button>
            {(device.downloadsDir ?? "") !== "" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={choosing}
                onClick={() => save({ downloadsDir: "" }, refresh)}
              >
                Use default
              </Button>
            )}
          </SettingRow>
        )}
        <SettingRow id="downloads-cap" label="Storage limit" description={usageText}>
          <ResponsiveSelect
            items={capItems}
            value={String(capOf(device.downloadsCapGB))}
            onValueChange={(next) => next && save({ downloadsCapGB: Number(next) })}
            aria-labelledby="downloads-cap-label"
            aria-describedby="downloads-cap-description"
            className="w-28"
          />
        </SettingRow>
        {/* The phone's own: downloads wait while the network is expensive
        (cellular or a hotspot) instead of spending the user's data. */}
        {feature("downloadsWiFiOnly") && (
          <SettingRow
            id="downloads-wifi"
            label="Download over Wi-Fi only"
            description="Downloads wait for Wi-Fi, not mobile data."
          >
            <Switch
              aria-labelledby="downloads-wifi-label"
              aria-describedby="downloads-wifi-description"
              checked={device.downloadsWiFiOnly}
              onCheckedChange={(downloadsWiFiOnly) => save({ downloadsWiFiOnly })}
            />
          </SettingRow>
        )}
      </SettingsGroup>
      {/* Go's DeleteAll clears the device, every profile's records with it, so
      it is never a row a kid sees (and Go refuses it from a kid anyway). */}
      {!kids && (
        <SettingsGroup>
          <SettingRow
            id="downloads-delete-all"
            label="Delete all downloads"
            description="Removes this device’s downloads, for every profile."
          >
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={!hasDownloads}
              onClick={() => setConfirming(true)}
            >
              Delete all…
            </Button>
          </SettingRow>
        </SettingsGroup>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all downloads on this device?</AlertDialogTitle>
            <AlertDialogDescription>Every profile’s downloads are removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={deleteAll}>
              Delete all downloads
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
