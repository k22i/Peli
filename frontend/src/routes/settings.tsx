import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import { SignOutDialog } from "@/components/account/sign-out-dialog";
import { AudioLanguagesRow } from "@/components/settings/audio-languages";
import { DiagnosticsRows } from "@/components/settings/diagnostics-rows";
import { DownloadsPane } from "@/components/settings/downloads-pane";
import { LiveTVPane } from "@/components/settings/livetv-pane";
import { LicencesDialog } from "@/components/settings/licences-dialog";
import {
  defaultPane,
  paneFromSearch,
  rememberPane,
  visiblePanes,
  type PaneId,
} from "@/components/settings/panes";
import { PluginsPane } from "@/components/settings/plugins-pane";
import { ServerDialog } from "@/components/settings/server-dialog";
import {
  paneHeadingId,
  SettingRow,
  SettingsGroup,
  SettingsPaneList,
  SettingsPaneRail,
  SettingsPaneView,
  SettingsRoot,
} from "@/components/settings/settings-section";
import { TmdbDialog } from "@/components/settings/tmdb-dialog";
import { UpdateRows } from "@/components/settings/update-rows";
import { AddDeviceDialog, CopyDeviceDialog } from "@/components/settings/pairing-dialogs";
import {
  AniListDialog,
  SharedDisconnectDialog,
  SimklDialog,
} from "@/components/settings/tracking-dialogs";
import {
  defaultSubtitleStyle,
  SubtitleStyleEditor,
  subtitlePreviewStyle,
  type SubtitleStyle,
} from "@/components/player/subtitle-panel";
import { Button, buttonVariants } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { posterAddons } from "@/lib/anime-titles";
import { useLoadedAddons } from "@/lib/home";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ResponsiveSelect } from "@/components/ui/responsive-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { addonsQuery } from "@/lib/addons";
import { feature } from "@/lib/features";
import { useCompactShell } from "@/lib/shell-mode";
import { appBuildQuery, appVersionQuery } from "@/lib/app-info";
import { contentDisclaimer } from "@/lib/disclaimer";
import { deviceName as hostName, isIOS, isTouch, thisDevice } from "@/lib/platform";
import { useCurrentProfile } from "@/lib/profile";
import { serverName, serverQuery } from "@/lib/server";
import {
  audioLanguagesOf,
  captionsModes,
  deviceSettingsQuery,
  displayModeOf,
  displayModes,
  languageName,
  languages,
  maxResolutionOf,
  maxResolutions,
  profileSettingsQuery,
  useSaveDeviceSettings,
  useSaveProfileSettings,
  type DeviceSettings,
  type ProfileSettings,
} from "@/lib/settings";
import {
  pictureControls,
  picturePresets,
  presetName,
  presetPicture,
  signed,
  standardPicture,
  userPreset,
  type Picture,
} from "@/lib/picture";
import { adjustedTitlesQuery } from "@/lib/title-adjustments";
import { defaultStillWatchingAfter, stillWatchingChoices } from "@/lib/still-watching";
import { defaultFraming, fitModes } from "@/lib/framing";
import {
  defaultAudio,
  defaultSound,
  deviceName,
  equalizerHint,
  equalizerPresets,
  type Audio,
  type Sound,
} from "@/lib/sound";
import {
  debandLevels,
  defaultQuality,
  deinterlaceModes,
  heavyWarning,
  scalingHint,
  scalingPresets,
  toneMappings,
  upscalerHint,
  upscalers,
  type Quality,
} from "@/lib/quality";
import { useTmdbKey } from "@/lib/tmdb";
import { Service as Store, type Gestures } from "@bindings/store";
import { Service as Player } from "@bindings/player";
import {
  sharedWith,
  trackingQuery,
  useDisconnectAniList,
  useDisconnectSimkl,
  useForgetSimkl,
  useImport,
  type Connections,
} from "@/lib/tracking";
import {
  formatBytes,
  torrentCacheQuery,
  torrentCacheSizes,
  Torrents,
  useClearTorrentCache,
} from "@/lib/torrent";

export const Route = createFileRoute("/settings")({
  validateSearch: paneFromSearch,
  component: Settings,
});

// The few settings Peli needs (#17, regrouped into panes in #120): a list of
// panes on the left and one pane on the right, as in System Settings. It
// should stay short rather than grow into a control panel. Reached from the
// profile menu, outside the six-item nav; `?section=` names the pane
// (components/settings/panes.ts).
function Settings() {
  const profile = useCurrentProfile();
  const { section: asked } = Route.useSearch();
  const section = asked ?? defaultPane;
  const compact = useCompactShell();
  const pane = visiblePanes().find((candidate) => candidate.id === section) ?? visiblePanes()[0]!;
  const fromKeyboard = useRef(false);
  const shown = useRef<PaneId>(undefined);

  // A new pane starts at its top. Focus moves to its title only when the
  // change came from the keyboard, so the next Tab lands in the pane.
  useEffect(() => {
    rememberPane(pane.id);
    const before = shown.current;
    shown.current = pane.id;
    if (before === undefined || before === pane.id) return;
    const content = document.getElementById("content");
    if (content) content.scrollTop = 0;
    if (!fromKeyboard.current) return;
    fromKeyboard.current = false;
    document.getElementById(paneHeadingId)?.focus({ preventScroll: true });
  }, [pane.id]);

  // On the phone Settings is a list of panes you drill into (#137): no
  // `?section=` is the list, one is that pane with Back in the top strip.
  if (compact) {
    return (
      <div className="w-full px-[calc(1rem+max(env(safe-area-inset-left),env(safe-area-inset-right)))] [--spacing-page:calc(1rem+max(env(safe-area-inset-left),env(safe-area-inset-right)))]">
        {asked === undefined ? (
          <SettingsRoot />
        ) : (
          <Pane id={pane.id} title={pane.title} profileId={profile.id} />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-page pt-8 pb-16 md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:items-start md:gap-14">
      <div className="mb-6 md:sticky md:top-[calc(var(--spacing-bar)+2rem)] md:mb-0">
        <h1 className="mb-6 font-display text-[clamp(2.75rem,1.9rem+2.6vw,4.5rem)] leading-[0.95] tracking-[-0.01em]">
          Settings
        </h1>
        <SettingsPaneList
          current={pane.id}
          onNavigate={(viaKeyboard) => {
            fromKeyboard.current = viaKeyboard;
          }}
          className="max-md:hidden"
        />
        <SettingsPaneRail current={pane.id} className="md:hidden" />
      </div>
      <Pane id={pane.id} title={pane.title} profileId={profile.id} />
    </div>
  );
}

function Pane({
  id,
  title,
  profileId,
}: {
  id: PaneId;
  title: string;
  profileId?: number | undefined;
}) {
  switch (id) {
    case "account":
      return <AccountPane title={title} />;
    case "content":
      return <ContentPane title={title} profileId={profileId} />;
    case "playback":
      return <PlaybackPane title={title} profileId={profileId} />;
    case "languages":
      return <LanguagesPane title={title} profileId={profileId} />;
    case "streaming":
      return <StreamingPane title={title} profileId={profileId} />;
    case "downloads":
      return <DownloadsPane title={title} profileId={profileId} />;
    case "livetv":
      return <LiveTVPane title={title} profileId={profileId} />;
    case "plugins":
      return <PluginsPane title={title} profileId={profileId} />;
    case "tracking":
      return <TrackingPane title={title} profileId={profileId} />;
    case "privacy":
      return <PrivacyPane title={title} profileId={profileId} />;
    case "about":
    default:
      return <AboutPane title={title} />;
  }
}

type SettingsData = {
  settings: ProfileSettings;
  device: DeviceSettings;
  setProfile: (change: Partial<ProfileSettings>) => void;
  setDevice: (change: Partial<DeviceSettings>) => void;
};

// Everything that needs the current profile's or the device's settings.
// Shows a placeholder until both are there.
function WithSettings({
  profileId,
  children,
}: {
  profileId: number | undefined;
  children: (data: SettingsData) => ReactNode;
}) {
  if (profileId === undefined) return <Skeleton className="h-48 rounded-2xl" />;
  return <LoadedSettings profileId={profileId}>{children}</LoadedSettings>;
}

function LoadedSettings({
  profileId,
  children,
}: {
  profileId: number;
  children: (data: SettingsData) => ReactNode;
}) {
  const profileSettings = useQuery(profileSettingsQuery(profileId));
  const deviceSettings = useQuery(deviceSettingsQuery);
  const saveProfile = useSaveProfileSettings(profileId);
  const saveDevice = useSaveDeviceSettings();

  if (!profileSettings.data || !deviceSettings.data) {
    return <Skeleton className="h-48 rounded-2xl" />;
  }
  const settings = profileSettings.data;
  const device = deviceSettings.data;
  return children({
    settings,
    device,
    setProfile: (change) => saveProfile.mutate({ ...settings, ...change }),
    setDevice: (change) => saveDevice.mutate({ ...device, ...change }),
  });
}

function AccountPane({ title }: { title: string }) {
  const profile = useCurrentProfile();
  const server = useQuery(serverQuery);
  const [signingOut, setSigningOut] = useState(false);
  const [pickingServer, setPickingServer] = useState(false);

  // The Guest never syncs, even beside a signed-in account (ADR-0010).
  const status = profile.guest
    ? "Local profile, kept on this device"
    : profile.signedIn
      ? "Synced with Nuvio"
      : "Nuvio session ended, kept on this device";
  const nuvio = profile.signedIn
    ? profile.guest
      ? "Signed in. Profiles sync across devices; Guest stays on this one."
      : "Signed in. Library, progress and addons sync across devices."
    : profile.sessionEnded
      ? "Session ended. Sign in again to keep syncing; nothing here is lost."
      : "Sign in to sync your library, progress and addons.";

  return (
    <SettingsPaneView title={title}>
      <SettingsGroup title="Nuvio">
        <div className="flex min-h-14 items-center gap-3 px-4 py-3.5">
          <ProfileAvatar profile={profile} className="size-9" />
          <div className="flex flex-col">
            <span className="type-item">{profile.name}</span>
            <span className="text-small text-muted-foreground">{status}</span>
          </div>
        </div>
        <SettingRow id="nuvio" label="Nuvio account" description={nuvio}>
          {!profile.signedIn && (
            <Link
              to="/sign-in"
              search={profile.sessionEnded ? { reason: "session-ended" } : {}}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Sign in
            </Link>
          )}
          {(profile.signedIn || profile.sessionEnded) && (
            <Button variant="outline" size="sm" onClick={() => setSigningOut(true)}>
              Sign out
            </Button>
          )}
        </SettingRow>
        <SignOutDialog open={signingOut} onOpenChange={setSigningOut} />
        <SettingRow
          id="server"
          label="Server"
          description={
            !server.data
              ? "…"
              : server.data.custom
                ? `Your own server, ${serverName(server.data.url)}.`
                : "Nuvio’s server. You can use your own instead."
          }
        >
          <Button
            variant="outline"
            size="sm"
            aria-label="Change server"
            disabled={!server.data}
            onClick={() => setPickingServer(true)}
          >
            Change
          </Button>
        </SettingRow>
        {server.data && (
          <ServerDialog server={server.data} open={pickingServer} onOpenChange={setPickingServer} />
        )}
      </SettingsGroup>
      <SettingsGroup title="Profiles">
        <SettingRow id="profiles" label="Profiles" description="Add, rename or delete profiles.">
          <Link
            to="/profiles"
            search={{ manage: true }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Manage
          </Link>
        </SettingRow>
        <AskWhoRow />
      </SettingsGroup>
    </SettingsPaneView>
  );
}

// The other side of the picker's "Don't ask again": on, Peli asks who's
// watching at launch when there's more than one profile.
function AskWhoRow() {
  const device = useQuery(deviceSettingsQuery);
  const save = useSaveDeviceSettings();
  if (!device.data) return null;
  const settings = device.data;
  return (
    <SettingRow
      id="ask-who"
      label="Ask who’s watching"
      description={`At launch on ${thisDevice()}. Off: opens as the last profile.`}
    >
      <Switch
        aria-labelledby="ask-who-label"
        aria-describedby="ask-who-description"
        checked={!settings.skipProfilePicker}
        onCheckedChange={(ask) => save.mutate({ ...settings, skipProfilePicker: !ask })}
      />
    </SettingRow>
  );
}

function ContentPane({ title, profileId }: { title: string; profileId: number | undefined }) {
  return (
    <SettingsPaneView title={title}>
      <WithSettings profileId={profileId}>
        {({ settings, setProfile }) => (
          <>
            {/* Debrid keys stay with the addons (#54, ADR-0038), so the
                debrid row only points there. */}
            <SettingsGroup title="Addons">
              <InstalledAddonsRow profileId={profileId!} />
              <SettingRow
                id="debrid"
                label="Debrid services"
                description="Set up TorBox, AllDebrid or Premiumize in a stream addon’s settings. Peli never asks for your key."
              >
                <Link to="/addons" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open addons
                </Link>
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title="Catalogs">
              {/* #109: anime the anime list knows is the Anime tab's. */}
              <SettingRow
                id="anime-in-movies-and-shows"
                label="Show anime in Movies and Shows"
                description="Off: anime shows only under Anime."
              >
                <Switch
                  aria-labelledby="anime-in-movies-and-shows-label"
                  aria-describedby="anime-in-movies-and-shows-description"
                  checked={settings.animeInMoviesAndShows}
                  onCheckedChange={(animeInMoviesAndShows) => setProfile({ animeInMoviesAndShows })}
                />
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title="Episodes">
              <SettingRow
                id="hide-spoilers"
                label="Hide spoilers"
                description="Blurs art and text for episodes you haven’t watched."
              >
                <Switch
                  aria-labelledby="hide-spoilers-label"
                  aria-describedby="hide-spoilers-description"
                  checked={settings.hideSpoilers}
                  onCheckedChange={(hideSpoilers) => setProfile({ hideSpoilers })}
                />
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title="Artwork">
              <TmdbRow />
              <AnimePostersRow
                profileId={profileId!}
                value={settings.animePosterAddon ?? ""}
                onChange={(animePosterAddon) => setProfile({ animePosterAddon })}
              />
            </SettingsGroup>
          </>
        )}
      </WithSettings>
    </SettingsPaneView>
  );
}

function PlaybackPane({ title, profileId }: { title: string; profileId: number | undefined }) {
  const compact = useCompactShell();
  // The phone has no Fill fit: its pinch fills the screen already.
  const fillFit = feature("fillFit");
  const fits = fitModes.filter(({ id }) => id !== "fill" || fillFit).map(({ id }) => id);
  return (
    <SettingsPaneView title={title}>
      <WithSettings profileId={profileId}>
        {({ settings, device, setProfile, setDevice }) => (
          <>
            {/* The iOS player applies the picture, sound and HDR settings too
                (the sheet's tabs are the same there); a row for something it
                can't do is left out where it's written, below. */}
            <SettingsGroup title="Video">
              <SettingRow
                id="hardware-decoding"
                label="Hardware decoding"
                description="Decodes on the graphics card, saving power. Off if playback stutters. Next video on this device."
              >
                <Switch
                  aria-labelledby="hardware-decoding-label"
                  aria-describedby="hardware-decoding-description"
                  checked={device.hardwareDecoding}
                  onCheckedChange={(hardwareDecoding) => setDevice({ hardwareDecoding })}
                />
              </SettingRow>
              <QualityDefaults
                quality={device.quality ?? defaultQuality}
                setQuality={(changes) =>
                  setDevice({ quality: { ...(device.quality ?? defaultQuality), ...changes } })
                }
              />
            </SettingsGroup>
            <SettingsGroup title="HDR on a screen without it">
              <SettingRow
                id="tone-mapping"
                label="Tone mapping"
                description="How HDR fits a screen that can't show it. Natural stays true; Bright lifts; Filmic softens highlights. This device."
              >
                <Choice
                  id="tone-mapping"
                  value={(device.quality ?? defaultQuality).toneMapping}
                  options={toneMappingIds}
                  labels={toneMappingLabels}
                  onChange={(toneMapping) =>
                    setDevice({
                      quality: { ...(device.quality ?? defaultQuality), toneMapping },
                    })
                  }
                />
              </SettingRow>
              <SettingRow
                id="target-peak"
                label="Screen brightness"
                description="Tone-mapping brightness for this screen. Auto lets the player guess; higher keeps more highlights."
              >
                <Choice
                  id="target-peak"
                  value={String((device.quality ?? defaultQuality).targetPeak)}
                  options={["0", "100", "200", "300", "400", "600"]}
                  labels={{
                    "0": "Auto",
                    "100": "100",
                    "200": "200",
                    "300": "300",
                    "400": "400",
                    "600": "600 nits",
                  }}
                  onChange={(peak) =>
                    setDevice({
                      quality: {
                        ...(device.quality ?? defaultQuality),
                        targetPeak: Number(peak),
                      },
                    })
                  }
                />
              </SettingRow>
            </SettingsGroup>
            <PictureDefaults profileId={profileId} settings={settings} setProfile={setProfile} />
            <SettingsGroup title="Framing">
              <SettingRow
                id="framing-fit"
                label="Fit"
                description={
                  isTouch()
                    ? "How the picture fills the screen. Pinch to fill."
                    : "How the picture fills the window. A title can have its own (P › Framing, or Shift+F)."
                }
              >
                <Choice
                  id="framing-fit"
                  value={settings.framing?.fit ?? "fit"}
                  options={fits}
                  labels={{
                    fit: "Fit",
                    fill: "Fill",
                    stretch: "Stretch",
                    original: "Original",
                  }}
                  onChange={(fit) =>
                    setProfile({ framing: { ...(settings.framing ?? defaultFraming), fit } })
                  }
                />
              </SettingRow>
              <SettingRow
                id="auto-crop"
                label="Remove black bars"
                description={`Crops the bars around a wide film. Never cuts into the picture.${isIOS() ? " On iPhone: up to 1080p." : ""}`}
              >
                <Switch
                  aria-labelledby="auto-crop-label"
                  aria-describedby="auto-crop-description"
                  checked={settings.framing?.autoCrop ?? false}
                  onCheckedChange={(autoCrop) =>
                    setProfile({
                      framing: { ...(settings.framing ?? defaultFraming), autoCrop },
                    })
                  }
                />
              </SettingRow>
            </SettingsGroup>
            <SoundDefaults
              sound={settings.sound ?? defaultSound}
              setSound={(changes) =>
                setProfile({ sound: { ...(settings.sound ?? defaultSound), ...changes } })
              }
              audio={device.audio ?? defaultAudio}
              setAudio={(changes) =>
                setDevice({ audio: { ...(device.audio ?? defaultAudio), ...changes } })
              }
            />
            {/* The touch player's gestures (#131), on iOS only. */}
            {isIOS() && (
              <GestureSettings
                gestures={settings.gestures ?? defaultGestures}
                setGestures={(changes) =>
                  setProfile({
                    gestures: { ...(settings.gestures ?? defaultGestures), ...changes },
                  })
                }
              />
            )}
            <SettingsGroup title="Next episode">
              <SettingRow
                id="still-watching"
                label="Ask “Still watching?” between episodes"
                description="Episodes play back to back; after this many in a row, the next one waits for you."
              >
                <Choice
                  id="still-watching"
                  value={String(settings.stillWatchingAfter ?? defaultStillWatchingAfter)}
                  options={stillWatchingOptions}
                  labels={stillWatchingLabels}
                  onChange={(after) => setProfile({ stillWatchingAfter: Number(after) })}
                />
              </SettingRow>
            </SettingsGroup>
            {/* #69: chapters first, IntroDB for files without them. */}
            <SettingsGroup title="Intros and credits">
              <SettingRow
                id="skip-intros"
                label="Skip intros automatically"
                description="Skips intros and recaps when Peli knows where they are."
              >
                <Switch
                  aria-labelledby="skip-intros-label"
                  aria-describedby="skip-intros-description"
                  checked={settings.skipIntros}
                  onCheckedChange={(skipIntros) => setProfile({ skipIntros })}
                />
              </SettingRow>
              <SettingRow
                id="skip-times-online"
                label="Look up intro and credits times"
                description="Asks IntroDB (introdb.app) about videos that don’t mark them, sending what you play. This device."
              >
                <Switch
                  aria-labelledby="skip-times-online-label"
                  aria-describedby="skip-times-online-description"
                  checked={device.skipTimesOnline}
                  onCheckedChange={(skipTimesOnline) => setDevice({ skipTimesOnline })}
                />
              </SettingRow>
            </SettingsGroup>
            {/* The watch party kept beside the video (ADR-0051, the player's
                "Keep open"). The compact iOS shell has no room for a sidebar,
                so it keeps its bottom sheet and no option. */}
            {!compact && (
              <SettingsGroup title="Watch party">
                <SettingRow
                  id="party-dock"
                  label="Keep watch party open beside the video"
                  description="Keeps the party in a sidebar while the video plays. Off: W opens it over the video. This device."
                >
                  <Switch
                    aria-labelledby="party-dock-label"
                    aria-describedby="party-dock-description"
                    checked={device.partyDock ?? false}
                    onCheckedChange={(partyDock) => setDevice({ partyDock })}
                  />
                </SettingRow>
              </SettingsGroup>
            )}
          </>
        )}
      </WithSettings>
    </SettingsPaneView>
  );
}

const defaultGestures: Gestures = {
  levelSwipes: true,
  seekSwipe: true,
  holdForSpeed: true,
  doubleTapSkip: 10,
};
const doubleTapSkips = ["5", "10", "15", "30"] as const;
const doubleTapLabels: Record<(typeof doubleTapSkips)[number], string> = {
  "5": "5 s",
  "10": "10 s",
  "15": "15 s",
  "30": "30 s",
};

// Settings › Playback › Gestures (#131): which of the touch player's
// picture gestures are on, and how far a double tap skips.
function GestureSettings({
  gestures,
  setGestures,
}: {
  gestures: Gestures;
  setGestures: (changes: Partial<Gestures>) => void;
}) {
  const toggle = (
    id: string,
    label: string,
    description: string,
    key: "levelSwipes" | "seekSwipe" | "holdForSpeed",
  ) => (
    <SettingRow id={id} label={label} description={description}>
      <Switch
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        checked={gestures[key]}
        onCheckedChange={(on) => setGestures({ [key]: on })}
      />
    </SettingRow>
  );
  return (
    <SettingsGroup title="Gestures">
      {toggle(
        "level-swipes",
        "Brightness and volume swipes",
        "Swipe on the left for brightness, on the right for volume.",
        "levelSwipes",
      )}
      {toggle(
        "seek-swipe",
        "Swipe to seek",
        "Swipe sideways across the picture to move through the video.",
        "seekSwipe",
      )}
      {toggle(
        "hold-for-speed",
        "Hold for 2×",
        "Touch and hold the picture to play at double speed until you let go.",
        "holdForSpeed",
      )}
      <SettingRow
        id="double-tap-skip"
        label="Double-tap skip"
        description="How far a double tap or the skip buttons go."
      >
        <Choice
          id="double-tap-skip"
          value={String(gestures.doubleTapSkip)}
          options={doubleTapSkips}
          labels={doubleTapLabels}
          onChange={(skip) => setGestures({ doubleTapSkip: Number(skip) })}
        />
      </SettingRow>
    </SettingsGroup>
  );
}

const stillWatchingOptions = stillWatchingChoices.map(String);
const stillWatchingLabels: Record<string, string> = Object.fromEntries(
  stillWatchingChoices.map((after) => [String(after), after === 0 ? "Never" : `After ${after}`]),
);

const toneMappingIds: string[] = toneMappings.map(({ id }) => id);
const toneMappingLabels: Record<string, string> = Object.fromEntries(
  toneMappings.map(({ id, name }) => [id, name]),
);

// How titles sound unless they have their own (the player's Sound tab), and
// this device's output.
function SoundDefaults({
  sound,
  setSound,
  audio,
  setAudio,
}: {
  sound: Sound;
  setSound: (changes: Partial<Sound>) => void;
  audio: Audio;
  setAudio: (changes: Partial<Audio>) => void;
}) {
  // iOS has the system's own output and AudioDevices isn't bound there, so
  // the query stays off (and pending) rather than failing: the row that would
  // show it is left out below.
  const output = feature("audioOutput");
  const devices = useQuery({
    queryKey: ["player", "audio-devices"],
    queryFn: async () => (await Player.AudioDevices()) ?? [],
    enabled: output,
  }).data;
  const items = (devices?.length ? devices : [{ name: "auto", description: "" }]).map((each) => ({
    value: each.name,
    label: deviceName(each),
  }));
  // A device saved here and unplugged since stays listed, so it can be seen.
  if (!items.some((item) => item.value === audio.device)) {
    items.push({ value: audio.device, label: `${audio.device} (not connected)` });
  }
  return (
    <SettingsGroup title="Sound">
      {output && (
        <SettingRow
          id="audio-device"
          label="Output"
          description={`Where sound goes. System default follows the ${isIOS() ? "device" : "Mac"}'s settings. This device.`}
        >
          <ResponsiveSelect
            items={items}
            value={audio.device}
            onValueChange={(next) => next && setAudio({ device: next })}

            aria-labelledby="audio-device-label"
            aria-describedby="audio-device-description"
            className="w-56"
          />
        </SettingRow>
      )}
      <SettingRow
        id="stereo-downmix"
        label="Stereo downmix"
        description="Downmixes surround to two channels, for speakers or headphones. This device."
      >
        <Switch
          aria-labelledby="stereo-downmix-label"
          aria-describedby="stereo-downmix-description"
          checked={audio.stereoDownmix}
          onCheckedChange={(stereoDownmix) => setAudio({ stereoDownmix })}
        />
      </SettingRow>
      {feature("volumeBoost") && (
        <SettingRow
          id="volume-boost"
          label="Volume up to 150 %"
          description="For quiet tracks. Above 100 % loud parts can distort. This device."
        >
          <Switch
            aria-labelledby="volume-boost-label"
            aria-describedby="volume-boost-description"
            checked={audio.volumeBoost}
            onCheckedChange={(volumeBoost) => setAudio({ volumeBoost })}
          />
        </SettingRow>
      )}
      <SettingRow
        id="dialogue-boost"
        label="Dialogue boost"
        description={
          isTouch()
            ? "Lifts speech over music and effects. Surround plays from the front. This device."
            : "Lifts speech over music and effects (B in the player). Surround plays from the front. This device."
        }
      >
        <Switch
          aria-labelledby="dialogue-boost-label"
          aria-describedby="dialogue-boost-description"
          checked={sound.dialogueBoost}
          onCheckedChange={(dialogueBoost) => setSound({ dialogueBoost })}
        />
      </SettingRow>
      <SettingRow
        id="night-mode"
        label="Night mode"
        description="Evens out loud and quiet, for watching late."
      >
        <Switch
          aria-labelledby="night-mode-label"
          aria-describedby="night-mode-description"
          checked={sound.nightMode}
          onCheckedChange={(nightMode) => setSound({ nightMode })}
        />
      </SettingRow>
      <SettingRow
        id="equalizer"
        label="Equalizer"
        description={equalizerHint[sound.equalizer] ?? ""}
      >
        <Choice
          id="equalizer"
          value={sound.equalizer}
          {...choices(equalizerPresets)}
          onChange={(equalizer) => setSound({ equalizer })}
        />
      </SettingRow>
    </SettingsGroup>
  );
}

// A Choice's options and labels from a list of choices.
const choices = (
  list: readonly { id: string; name: string }[],
): { options: string[]; labels: Record<string, string> } => ({
  options: list.map(({ id }) => id),
  labels: Object.fromEntries(list.map(({ id, name }) => [id, name])),
});

// How hard the renderer works on this device, unless a title has its own
// (the player's Picture & sound sheet, Quality tab).
function QualityDefaults({
  quality,
  setQuality,
}: {
  quality: Quality;
  setQuality: (changes: Partial<Quality>) => void;
}) {
  // The same rows the player's Quality tab leaves out on iOS (Go doesn't
  // apply them there); scaling and debanding stay.
  const shaders = feature("renderShaders");
  return (
    <>
      <SettingRow
        id="scaling"
        label="Scaling"
        description={`${scalingHint[quality.scaling] ?? ""} This device.`}
      >
        <Choice
          id="scaling"
          value={quality.scaling}
          {...choices(scalingPresets)}
          onChange={(scaling) => setQuality({ scaling })}
        />
      </SettingRow>
      <SettingRow
        id="deband"
        label="Debanding"
        description="Smooths banding in skies and dark gradients. High softens fine texture."
      >
        <Choice
          id="deband"
          value={quality.deband}
          {...choices(debandLevels)}
          onChange={(deband) => setQuality({ deband })}
        />
      </SettingRow>
      {shaders && (
        <>
          <SettingRow
            id="sharpen"
            label="Sharpening"
            description="AMD's contrast-adaptive sharpening: crisper detail, no halos."
          >
            <Choice
              id="sharpen"
              value={String(quality.sharpen)}
              options={["0", "3", "5", "8"]}
              labels={{ "0": "Off", "3": "Light", "5": "Medium", "8": "Strong" }}
              onChange={(sharpen) => setQuality({ sharpen: Number(sharpen) })}
            />
          </SettingRow>
          <SettingRow
            id="upscaler"
            label="Upscaling"
            description={upscalerHint[quality.upscaler] ?? ""}
          >
            <Choice
              id="upscaler"
              value={quality.upscaler}
              {...choices(upscalers)}
              onChange={(upscaler) => setQuality({ upscaler })}
            />
          </SettingRow>
        </>
      )}
      {feature("motionSmoothing") && (
        <SettingRow
          id="motion-smoothing"
          label="Motion smoothing"
          description={`Blends extra frames: smoother pans, but films can look like TV. Uses more power. ${heavyWarning({ ...quality, motionSmoothing: true }) ?? ""}`}
        >
          <Switch
            aria-labelledby="motion-smoothing-label"
            aria-describedby="motion-smoothing-description"
            checked={quality.motionSmoothing}
            onCheckedChange={(motionSmoothing) => setQuality({ motionSmoothing })}
          />
        </SettingRow>
      )}
      {feature("deinterlace") && (
        <SettingRow
          id="deinterlace"
          label="Deinterlacing"
          description="For TV recordings and DVDs. Auto does only video marked interlaced."
        >
          <Choice
            id="deinterlace"
            value={quality.deinterlace}
            {...choices(deinterlaceModes)}
            onChange={(deinterlace) => setQuality({ deinterlace })}
          />
        </SettingRow>
      )}
    </>
  );
}

// The picture every title plays with unless it has its own (the player's
// Picture & sound sheet keeps those per title), the profile's own presets,
// and the titles adjusted.
function PictureDefaults({
  profileId,
  settings,
  setProfile,
}: {
  profileId: number | undefined;
  settings: ProfileSettings;
  setProfile: (changes: Partial<ProfileSettings>) => void;
}) {
  const named = settings.picturePresets ?? [];
  const current = settings.picture ?? standardPicture;
  const options = [
    ...picturePresets.map(({ id }) => id),
    ...(current.preset === "custom" ? ["custom"] : []),
    ...named.map(({ name }) => userPreset(name)),
  ];
  const labels = Object.fromEntries(options.map((id) => [id, presetName(id)]));
  const id = profileId ?? 0;
  const adjusted = useQuery({ ...adjustedTitlesQuery(id), enabled: id > 0 }).data ?? 0;
  const queryClient = useQueryClient();
  const clearTitles = () =>
    Store.ClearTitleAdjustments(id).then(
      () => {
        void queryClient.invalidateQueries({ queryKey: ["title-adjustments", id] });
        toastManager.add({ type: "success", title: "Every title follows your defaults again" });
      },
      () => toastManager.add({ type: "error", title: "Couldn’t clear the titles’ adjustments" }),
    );
  return (
    <SettingsGroup title="Picture">
      <SettingRow
        id="picture-preset"
        label="Picture"
        description="How every title looks, unless you adjust it in the player (P)."
      >
        <Choice
          id="picture-preset"
          value={current.preset}
          options={options}
          labels={labels}
          onChange={(preset) => {
            const picture = presetPicture(preset, named);
            if (picture) setProfile({ picture });
          }}
        />
      </SettingRow>
      {named.map((preset) => (
        <SettingRow
          key={preset.name}
          id={`picture-preset-${preset.name}`}
          label={preset.name}
          description={pictureSummary(preset.picture)}
        >
          <Button
            variant="outline"
            size="sm"
            aria-label={`Delete preset ${preset.name}`}
            onClick={() => {
              const left = named.filter((each) => each.name !== preset.name);
              const usedIt = current.preset === userPreset(preset.name);
              setProfile({
                picturePresets: left,
                ...(usedIt && { picture: { ...current, preset: "custom" } }),
              });
            }}
          >
            Delete
          </Button>
        </SettingRow>
      ))}
      <SettingRow
        id="adjusted-titles"
        label="Titles you adjusted"
        description={
          adjusted === 0
            ? "None: every title follows your defaults."
            : `${adjusted} ${adjusted === 1 ? "title keeps its" : "titles keep their"} own picture, framing or quality.`
        }
      >
        <Button
          variant="outline"
          size="sm"
          disabled={adjusted === 0}
          onClick={() => void clearTitles()}
        >
          Clear
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}

// "Brightness −4 · Contrast +6": a preset's values that aren't 0.
function pictureSummary(picture: Picture): string {
  const parts = pictureControls
    .filter(({ key }) => picture[key] !== 0)
    .map(({ key, label }) => `${label} ${signed(picture[key])}`);
  if (picture.shadowLift) parts.push("Shadow lift");
  return parts.join(" · ") || "The file as it is";
}

// What the Anime tab's cards are: AniList's entries, or the IMDb titles they
// belong to as an addon (BetterPosters, Xperience…) has them, one card per
// show (lib/anime-titles.ts, ADR-0062).
function AnimePostersRow({
  profileId,
  value,
  onChange,
}: {
  profileId: number;
  value: string;
  onChange: (url: string) => void;
}) {
  const { addons } = useLoadedAddons(profileId);
  const items = [
    { value: "", label: "AniList" },
    ...posterAddons(addons).map((addon) => ({ value: addon.url, label: addon.manifest.name })),
  ];
  // An addon since removed: keep it showing until something else is picked.
  if (!items.some((item) => item.value === value)) items.push({ value, label: "Removed addon" });
  return (
    <SettingRow
      id="anime-posters"
      label="Anime titles"
      description="AniList picks what the Anime tab lists. With an addon, one card per show, opening on its season."
    >
      <ResponsiveSelect
        items={items}
        value={value}
        onValueChange={(next) => onChange(next ?? "")}
        aria-labelledby="anime-posters-label"
        aria-describedby="anime-posters-description"
        className="w-48"
      />
    </SettingRow>
  );
}

// How subtitles look: a sample line in the given style, and the player's own
// editor in a dialog. The player saves its changes here too. The profile's
// row and this device's both use it, so its id and words are the caller's.
function SubtitleLookRow({
  id,
  label,
  description,
  style,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  style: SubtitleStyle;
  onChange: (style: SubtitleStyle) => void;
}) {
  const [draft, setDraft] = useState<SubtitleStyle>();
  return (
    <SettingRow id={id} label={label} description={description}>
      <div
        aria-hidden
        className="hidden h-10 w-40 items-end justify-center overflow-hidden rounded-lg bg-linear-to-b from-[oklch(0.55_0.08_40)] to-[oklch(0.2_0.03_260)] pb-1.5 sm:flex"
      >
        <span style={subtitlePreviewStyle(style, 10)}>The light finds a way</span>
      </div>
      <Dialog
        open={draft !== undefined}
        onOpenChange={(open) => setDraft(open ? style : undefined)}
      >
        <DialogTrigger render={<Button variant="outline" size="sm" />}>Customise</DialogTrigger>
        <DialogPopup className="dark max-w-md bg-[rgb(18_16_14)] text-foreground">
          <DialogHeader>
            <DialogTitle>Subtitle look</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto pt-1">
            {draft && <SubtitleStyleEditor style={draft} onStyleChange={setDraft} />}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              variant="light"
              onClick={() => {
                if (draft) onChange(draft);
                setDraft(undefined);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingRow>
  );
}

function LanguagesPane({ title, profileId }: { title: string; profileId: number | undefined }) {
  return (
    <SettingsPaneView title={title}>
      <WithSettings profileId={profileId}>
        {({ settings, device, setProfile, setDevice }) => {
          // Old data, before the device kept subtitles of its own: off, in the
          // default style.
          const subtitles = device.subtitles;
          const always = subtitles?.always ?? false;
          const deviceStyle = subtitles?.style?.font ? subtitles.style : defaultSubtitleStyle;
          const deviceSubtitles = subtitles ?? { always, style: deviceStyle };
          return (
            <>
              <SettingsGroup title="Languages">
                <AudioLanguagesRow
                  value={audioLanguagesOf(settings)}
                  onChange={(audioLanguages) => setProfile({ audioLanguages })}
                />
                <SettingRow
                  id="subtitle-language"
                  label="Subtitle language"
                  description="Picked when a stream or subtitle addon has it."
                >
                  <LanguageSelect
                    id="subtitle-language"
                    value={settings.subtitleLanguage}
                    defaultLabel="Automatic"
                    onChange={(subtitleLanguage) => setProfile({ subtitleLanguage })}
                  />
                </SettingRow>
                <SettingRow
                  id="second-subtitle-language"
                  label="Second subtitle language"
                  description="Smaller, above the main subtitles, when an addon has it."
                >
                  <LanguageSelect
                    id="second-subtitle-language"
                    value={settings.secondSubtitleLanguage ?? ""}
                    defaultLabel="None"
                    onChange={(secondSubtitleLanguage) => setProfile({ secondSubtitleLanguage })}
                  />
                </SettingRow>
              </SettingsGroup>
              <SettingsGroup title="Subtitles">
                <SubtitleLookRow
                  id="subtitle-look"
                  label="Look"
                  description="Font, size, colour, edge and position."
                  style={
                    settings.subtitleStyle?.font ? settings.subtitleStyle : defaultSubtitleStyle
                  }
                  onChange={(subtitleStyle) => setProfile({ subtitleStyle })}
                />
                <SettingRow
                  id="captions"
                  label="Captions"
                  // On for everyone here, so this profile's own choice waits.
                  description={
                    always
                      ? `On for every profile on this ${hostName()}.`
                      : `System follows your ${hostName()}’s captions setting.`
                  }
                >
                  <Choice
                    id="captions"
                    value={settings.captions}
                    options={captionsModes}
                    labels={{ system: "System", on: "On", off: "Off" }}
                    onChange={(captions) => setProfile({ captions })}
                  />
                </SettingRow>
                {/* After Nuvio's AutoSync: timing from the video's own
                    subtitles, no audio (docs/spikes/subtitle-autosync.md). */}
                <SettingRow
                  id="auto-sync-subtitles"
                  label="Sync addon subtitles"
                  description="Lines up addon subtitles with the video, using the subtitles it ships with."
                >
                  <Switch
                    aria-labelledby="auto-sync-subtitles-label"
                    aria-describedby="auto-sync-subtitles-description"
                    checked={settings.autoSyncSubtitles}
                    onCheckedChange={(autoSyncSubtitles) => setProfile({ autoSyncSubtitles })}
                  />
                </SettingRow>
              </SettingsGroup>
              {/* Subtitles for everyone on this device, whatever profile is
                  watching (W4). Each profile's language still picks the
                  tracks. */}
              <SettingsGroup title="On this device">
                <SettingRow
                  id="always-subtitles"
                  label="Always show subtitles"
                  description={`Subtitles on for everyone on this ${hostName()}, in each profile’s language.`}
                >
                  <Switch
                    aria-labelledby="always-subtitles-label"
                    aria-describedby="always-subtitles-description"
                    checked={always}
                    onCheckedChange={(on) =>
                      setDevice({ subtitles: { ...deviceSubtitles, always: on } })
                    }
                  />
                </SettingRow>
                {always && (
                  <SubtitleLookRow
                    id="device-subtitle-look"
                    label="Subtitle style on this device"
                    description="Font, size, colour, edge and position, while Always show subtitles is on."
                    style={deviceStyle}
                    onChange={(style) =>
                      setDevice({ subtitles: { ...deviceSubtitles, always: true, style } })
                    }
                  />
                )}
              </SettingsGroup>
            </>
          );
        }}
      </WithSettings>
    </SettingsPaneView>
  );
}

function StreamingPane({ title, profileId }: { title: string; profileId: number | undefined }) {
  return (
    <SettingsPaneView title={title}>
      <WithSettings profileId={profileId}>
        {({ settings, device, setProfile, setDevice }) => (
          <>
            <QualityGroup
              device={device}
              onChange={setDevice}
              // The preferred quality is the profile's, not this device's.
              quality={preferredQualityOf(settings.preferredQuality)}
              setQuality={(preferredQuality) => setProfile({ preferredQuality })}
            />
            <SettingsGroup title="Starting">
              {/* Off unless the user turns it on (#101, ADR-0060): resolving
              ahead adds the stream to the debrid service's list. */}
              <SettingRow
                id="pre-resolve"
                label="Start cached streams sooner"
                description="Gets the top pick ready while you choose, when it’s cached. Adds it to your debrid list even if you don’t play it. This device."
              >
                <Switch
                  aria-labelledby="pre-resolve-label"
                  aria-describedby="pre-resolve-description"
                  checked={device.preResolve}
                  onCheckedChange={(preResolve) => setDevice({ preResolve })}
                />
              </SettingRow>
              {/* On unless the user turns it off: each thumbnail costs 1–4 MB
              of the stream (docs/spikes/seek-previews.md). */}
              <SettingRow
                id="seek-previews"
                label="Seek bar previews"
                description="Shows a thumbnail over the seek bar while you scrub. About 1–4 MB each."
              >
                <Switch
                  aria-labelledby="seek-previews-label"
                  aria-describedby="seek-previews-description"
                  checked={device.seekPreviews}
                  onCheckedChange={(seekPreviews) => setDevice({ seekPreviews })}
                />
              </SettingRow>
              {/* Off unless the user turns it on, like pre-resolve: the smaller
              copy is resolved and so added to the debrid service's list. */}
              <SettingRow
                id="previews-from-smaller"
                label="Previews from a smaller copy"
                description="Makes them from a smaller cached copy: less data, but that copy joins your debrid list."
              >
                <Switch
                  aria-labelledby="previews-from-smaller-label"
                  aria-describedby="previews-from-smaller-description"
                  checked={device.previewsFromSmaller}
                  disabled={!device.seekPreviews}
                  onCheckedChange={(previewsFromSmaller) => setDevice({ previewsFromSmaller })}
                />
              </SettingRow>
              {/* The profile's, not this device's: it plays by itself. */}
              <SettingRow
                id="autoplay-top-pick"
                label="Autoplay the top pick"
                description="Plays the best stream as soon as streams are in. Change it in the Streams sheet."
              >
                <Switch
                  aria-labelledby="autoplay-top-pick-label"
                  aria-describedby="autoplay-top-pick-description"
                  checked={settings.autoplayTopPick}
                  onCheckedChange={(autoplayTopPick) => setProfile({ autoplayTopPick })}
                />
              </SettingRow>
            </SettingsGroup>
            {feature("torrent") && (
              <SettingsGroup title="Torrents">
                {/* Off unless the user turns it on (#55, ADR-0040): peers see
                their IP address. */}
                <SettingRow
                  id="torrent-streaming"
                  label="Stream torrents"
                  description="Plays torrents with no debrid or direct link by fetching them from peers. They see your IP address and get pieces from you. This device."
                >
                  <Switch
                    aria-labelledby="torrent-streaming-label"
                    aria-describedby="torrent-streaming-description"
                    checked={device.torrentStreaming}
                    onCheckedChange={(torrentStreaming) => setDevice({ torrentStreaming })}
                  />
                </SettingRow>
                {device.torrentStreaming && (
                  <TorrentCacheRow
                    size={device.torrentCacheGB}
                    onChange={(torrentCacheGB) => {
                      setDevice({ torrentCacheGB });
                      Torrents.SetCacheSize(torrentCacheGB).catch(() => {});
                    }}
                  />
                )}
              </SettingsGroup>
            )}
          </>
        )}
      </WithSettings>
    </SettingsPaneView>
  );
}

// What the profile wants ranked first, whatever the device can show: "best"
// keeps the ranking's own order. The device's maximum resolution still caps
// it, so these say a preference, not a promise.
const preferredQualities = ["best", "2160p", "1080p", "720p"] as const;
const preferredQualityLabels: Record<(typeof preferredQualities)[number], string> = {
  best: "Best available",
  "2160p": "4K",
  "1080p": "1080p",
  "720p": "720p",
};
type PreferredQuality = (typeof preferredQualities)[number];

// A saved value this build doesn't know is the ranking's own order.
function preferredQualityOf(value: string | undefined): PreferredQuality {
  return preferredQualities.find((quality) => quality === value) ?? "best";
}

// What this device shows (#98, ADR-0048), for choosing between streams: the
// ranking's weights stay out of sight, so these say what the screen can do. A
// stream that doesn't fit is listed after the ones that do, never hidden. The
// one row that isn't the device's is the profile's preferred quality, ranked
// first before this device's cap applies.
function QualityGroup({
  device,
  onChange,
  quality,
  setQuality,
}: {
  device: DeviceSettings;
  onChange: (change: Partial<DeviceSettings>) => void;
  quality: PreferredQuality;
  setQuality: (quality: PreferredQuality) => void;
}) {
  return (
    <SettingsGroup title="Picture">
      <SettingRow
        id="preferred-quality"
        label="Preferred quality"
        description="Ranks this quality first. The maximum resolution still caps it."
      >
        <Choice
          id="preferred-quality"
          value={quality}
          options={preferredQualities}
          labels={preferredQualityLabels}
          onChange={(preferredQuality) => setQuality(preferredQuality)}
        />
      </SettingRow>
      <SettingRow
        id="max-resolution"
        label="Maximum resolution"
        description="The biggest picture to pick. Bigger streams are listed after the rest. This device."
      >
        <Choice
          id="max-resolution"
          value={maxResolutionOf(device)}
          options={maxResolutions}
          labels={{ auto: "Auto", "2160p": "4K", "1080p": "1080p", "720p": "720p" }}
          onChange={(maxResolution) => onChange({ maxResolution })}
        />
      </SettingRow>
      {feature("hdr") && (
        <>
          <SettingRow
            id="hdr"
            label="HDR"
            description="Prefers HDR streams if this screen shows them. This device."
          >
            <Choice
              id="hdr"
              value={displayModeOf(device.hdr)}
              options={displayModes}
              labels={displayLabels}
              onChange={(hdr) => onChange({ hdr })}
            />
          </SettingRow>
          <SettingRow
            id="dolby-vision"
            label="Dolby Vision"
            description="Prefers Dolby Vision streams, even with no HDR fallback. Auto leaves it off. This device."
          >
            <Choice
              id="dolby-vision"
              value={displayModeOf(device.dolbyVision)}
              options={displayModes}
              labels={displayLabels}
              onChange={(dolbyVision) => onChange({ dolbyVision })}
            />
          </SettingRow>
        </>
      )}
    </SettingsGroup>
  );
}

const displayLabels = { auto: "Auto", on: "On", off: "Off" };

// The setting is the consent only: diagnostics themselves are #90, and read
// it before sending anything.
function PrivacyPane({ title, profileId }: { title: string; profileId: number | undefined }) {
  return (
    <SettingsPaneView title={title}>
      <WithSettings profileId={profileId}>
        {({ device, setDevice }) => (
          <SettingsGroup>
            <SettingRow
              id="diagnostics"
              label="Share diagnostics"
              description="Sends crash reports and whether videos played. Never your library, accounts or stream links. This device."
            >
              <Switch
                aria-labelledby="diagnostics-label"
                aria-describedby="diagnostics-description"
                checked={device.diagnostics}
                onCheckedChange={(diagnostics) => setDevice({ diagnostics })}
              />
            </SettingRow>
          </SettingsGroup>
        )}
      </WithSettings>
    </SettingsPaneView>
  );
}

// Where streamed torrents' pieces go (#55): a cap, oldest out first, and a
// way to empty it.
function TorrentCacheRow({ size, onChange }: { size: number; onChange: (gb: number) => void }) {
  const used = useQuery(torrentCacheQuery).data;
  const clear = useClearTorrentCache();
  const items = torrentCacheSizes.map((gb) => ({ value: String(gb), label: `${gb} GB` }));
  return (
    <SettingRow
      id="torrent-cache"
      label="Torrent cache"
      description={`Keeps what you stream, up to this size, oldest deleted first. ${
        used === undefined ? "" : `${formatBytes(used)} used.`
      }`}
    >
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!used || clear.isPending}
          onClick={() => clear.mutate()}
        >
          Clear
        </Button>
        <ResponsiveSelect
          items={items}
          value={String(size)}
          onValueChange={(next) => next && onChange(Number(next))}

          aria-labelledby="torrent-cache-label"
          aria-describedby="torrent-cache-description"
          className="w-28"
        />
      </div>
    </SettingRow>
  );
}

// SIMKL and AniList (#71), connected per profile: kids profiles get
// neither. Their settings are the profile's.
function TrackingPane({ title, profileId }: { title: string; profileId: number | undefined }) {
  if (profileId === undefined) {
    return (
      <SettingsPaneView title={title}>
        <Skeleton className="h-48 rounded-2xl" />
      </SettingsPaneView>
    );
  }
  return <LoadedTrackingPane title={title} profileId={profileId} />;
}

function LoadedTrackingPane({ title, profileId }: { title: string; profileId: number }) {
  const connections = useQuery(trackingQuery(profileId)).data;
  return (
    <SettingsPaneView
      title={title}
      lead={
        connections &&
        (connections.kids
          ? "Kids profiles don’t connect to trackers."
          : "Keep SIMKL and AniList up to date. Each profile connects its own accounts.")
      }
    >
      <WithSettings profileId={profileId}>
        {({ settings, setProfile }) => (
          <TrackingGroups
            profileId={profileId}
            connections={connections}
            settings={settings}
            onChange={setProfile}
          />
        )}
      </WithSettings>
    </SettingsPaneView>
  );
}

function TrackingGroups({
  profileId,
  connections,
  settings,
  onChange,
}: {
  profileId: number;
  connections: Connections | undefined;
  settings: ProfileSettings;
  onChange: (change: Partial<ProfileSettings>) => void;
}) {
  const disconnectSimkl = useDisconnectSimkl(profileId);
  const disconnectAniList = useDisconnectAniList(profileId);
  const forgetSimkl = useForgetSimkl(profileId);
  const importNow = useImport(profileId);
  const [connecting, setConnecting] = useState<"simkl" | "anilist">();
  // A grant pairing shared with other devices asks how to disconnect (#133).
  const [disconnecting, setDisconnecting] = useState<"simkl" | "anilist">();
  // Copying connections to or from another device (#133).
  const [pairing, setPairing] = useState<"add" | "copy">();
  if (!connections) return <Skeleton className="h-48 rounded-2xl" />;
  if (connections.kids) return null;

  const simkl = connections.simkl;
  const anilist = connections.anilist;
  const simklShared = sharedWith(simkl?.shared);
  const anilistShared = sharedWith(anilist?.shared);
  // Turning an import on brings in what's there now.
  const setImport = (change: Partial<ProfileSettings>, on: boolean) => {
    onChange(change);
    if (on) importNow.mutate();
  };

  return (
    <>
      <SettingsGroup title="SIMKL">
        <SettingRow
          id="simkl"
          label="SIMKL"
          description={
            !connections.simklAvailable
              ? "Not available in this build."
              : simkl
                ? simkl.needsReconnect
                  ? simklShared
                    ? "Disconnected on another device. Connect again."
                    : `Connected as ${simkl.user}, but the sign-in expired. Connect again.`
                  : `Connected as ${simkl.user}. Scrobbles what you watch, marks it at 90 %.`
                : "Scrobble what you watch to SIMKL, and bring in your history."
          }
        >
          {connections.simklAvailable && (
            <div className="flex items-center gap-2">
              {simkl && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Disconnect SIMKL"
                  loading={disconnectSimkl.isPending || forgetSimkl.isPending}
                  onClick={() =>
                    // A grant another device revoked has nothing left to
                    // revoke: forget it.
                    simklShared
                      ? simkl.needsReconnect
                        ? forgetSimkl.mutate()
                        : setDisconnecting("simkl")
                      : disconnectSimkl.mutate()
                  }
                >
                  Disconnect
                </Button>
              )}
              {(!simkl || simkl.needsReconnect) && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={simkl ? "Reconnect SIMKL" : "Connect SIMKL"}
                  onClick={() => setConnecting("simkl")}
                >
                  {simkl ? "Reconnect" : "Connect"}
                </Button>
              )}
            </div>
          )}
        </SettingRow>
        {simkl && (
          <>
            <ToggleRow
              id="simkl-scrobble"
              label="Scrobble"
              description="Shows SIMKL what’s playing, and marks it watched when it ends."
              checked={settings.simklScrobble}
              onChange={(simklScrobble) => onChange({ simklScrobble })}
            />
            <ToggleRow
              id="simkl-import"
              label="Import watched history"
              description="Marks SIMKL’s watched as watched here, and in Nuvio. Never unmarks."
              checked={settings.simklImport}
              onChange={(simklImport) => setImport({ simklImport }, simklImport)}
            />
            <ToggleRow
              id="simkl-anime"
              label="Include anime"
              description="Off if you keep anime on AniList."
              checked={settings.simklAnime}
              onChange={(simklAnime) =>
                setImport({ simklAnime }, simklAnime && settings.simklImport)
              }
            />
          </>
        )}
      </SettingsGroup>
      <SettingsGroup title="AniList">
        <SettingRow
          id="anilist"
          label="AniList"
          description={
            !connections.anilistAvailable
              ? "Not available in this build."
              : anilist
                ? anilist.needsReconnect
                  ? `Connected as ${anilist.user}, but the sign-in ran out. Connect again.`
                  : `Connected as ${anilist.user}. Watched anime moves along on your list.`
                : "Update your AniList list as you watch anime, and bring in that list."
          }
        >
          {connections.anilistAvailable && (
            <div className="flex items-center gap-2">
              {anilist && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Disconnect AniList"
                  loading={disconnectAniList.isPending}
                  onClick={() =>
                    anilistShared ? setDisconnecting("anilist") : disconnectAniList.mutate()
                  }
                >
                  Disconnect
                </Button>
              )}
              {(!anilist || anilist.needsReconnect) && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={anilist ? "Reconnect AniList" : "Connect AniList"}
                  onClick={() => setConnecting("anilist")}
                >
                  {anilist ? "Reconnect" : "Connect"}
                </Button>
              )}
            </div>
          )}
        </SettingRow>
        {anilist && (
          <>
            <ToggleRow
              id="anilist-progress"
              label="Update progress"
              description="Moves the list’s progress on per episode, and completes it at the last."
              checked={settings.anilistProgress}
              onChange={(anilistProgress) => onChange({ anilistProgress })}
            />
            <ToggleRow
              id="anilist-import"
              label="Import list"
              description="Marks your AniList watched episodes as watched here."
              checked={settings.anilistImport}
              onChange={(anilistImport) => setImport({ anilistImport }, anilistImport)}
            />
          </>
        )}
      </SettingsGroup>
      <SettingsGroup title="Other devices">
        <SettingRow
          id="pair-add"
          label="Add to another device"
          description="Copy SIMKL, AniList and the TMDB key to another device over Wi-Fi."
        >
          <Button
            variant="outline"
            size="sm"
            aria-label="Add to another device"
            onClick={() => setPairing("add")}
          >
            Add…
          </Button>
        </SettingRow>
        <SettingRow
          id="pair-copy"
          label="Copy from another device"
          description="Get the connections another device has. Both must be on the same Nuvio account."
        >
          <Button
            variant="outline"
            size="sm"
            aria-label="Copy from another device"
            onClick={() => setPairing("copy")}
          >
            Copy…
          </Button>
        </SettingRow>
      </SettingsGroup>
      <AddDeviceDialog
        open={pairing === "add"}
        onOpenChange={(open) => setPairing(open ? "add" : undefined)}
      />
      <CopyDeviceDialog
        open={pairing === "copy"}
        onOpenChange={(open) => setPairing(open ? "copy" : undefined)}
      />
      <SimklDialog
        profileId={profileId}
        open={connecting === "simkl"}
        onOpenChange={(open) => setConnecting(open ? "simkl" : undefined)}
      />
      <AniListDialog
        profileId={profileId}
        open={connecting === "anilist"}
        onOpenChange={(open) => setConnecting(open ? "anilist" : undefined)}
      />
      {simklShared && (
        <SharedDisconnectDialog
          service="simkl"
          devices={simklShared}
          open={disconnecting === "simkl"}
          onOpenChange={(open) => setDisconnecting(open ? "simkl" : undefined)}
          onThisDevice={() => forgetSimkl.mutate()}
          onEverywhere={() => disconnectSimkl.mutate()}
        />
      )}
      {anilistShared && (
        <SharedDisconnectDialog
          service="anilist"
          devices={anilistShared}
          open={disconnecting === "anilist"}
          onOpenChange={(open) => setDisconnecting(open ? "anilist" : undefined)}
          onThisDevice={() => disconnectAniList.mutate()}
        />
      )}
    </>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingRow id={id} label={label} description={description}>
      <Switch
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        checked={checked}
        onCheckedChange={onChange}
      />
    </SettingRow>
  );
}

// The optional TMDB key (#47). It's kept in this computer's keychain, so it
// applies to every profile here.
function TmdbRow() {
  const key = useTmdbKey();
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingRow
        id="tmdb"
        label="TMDB"
        description={
          key === undefined
            ? "…"
            : key
              ? "Title pages show TMDB’s logos, backdrops and cast photos. This device."
              : "Add your own TMDB key for richer artwork and cast photos."
        }
      >
        <Button
          variant="outline"
          size="sm"
          aria-label={key ? "Change TMDB key" : "Add TMDB key"}
          disabled={key === undefined}
          onClick={() => setOpen(true)}
        >
          {key ? "Change" : "Add key"}
        </Button>
      </SettingRow>
      <TmdbDialog hasKey={Boolean(key)} open={open} onOpenChange={setOpen} />
    </>
  );
}

function InstalledAddonsRow({ profileId }: { profileId: number }) {
  const addons = useQuery(addonsQuery(profileId));
  const count = addons.data?.length;

  return (
    <SettingRow
      id="addons"
      label="Installed addons"
      description={
        count === undefined ? "…" : count === 1 ? "1 addon installed" : `${count} addons installed`
      }
    >
      <Link to="/addons" className={buttonVariants({ variant: "outline", size: "sm" })}>
        Manage addons
      </Link>
    </SettingRow>
  );
}

function AboutPane({ title }: { title: string }) {
  const version = useQuery(appVersionQuery);
  // The build number stamps each SideStore build, so you can tell which one is installed.
  const build = useQuery({ ...appBuildQuery, enabled: isIOS() });
  const versionText = version.data
    ? build.data
      ? `${version.data} (${build.data})`
      : version.data
    : "…";

  return (
    <SettingsPaneView title={title}>
      <SettingsGroup>
        <SettingRow id="version" label="Version">
          <span className="tnum text-small text-muted-foreground">{versionText}</span>
        </SettingRow>
        <UpdateRows />
        {/* The welcome screen says the same (#39). */}
        <SettingRow id="disclaimer" label="Content" description={contentDisclaimer} />
        <SettingRow id="licences" label="Licences" description="Open-source licences and notices.">
          <LicencesDialog labelledBy="licences-label" />
        </SettingRow>
        {feature("gallery") && (
          <SettingRow
            id="design-system"
            label="Design system"
            description="Every token and component."
          >
            <Link
              to="/gallery"
              aria-labelledby="design-system-label"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open
            </Link>
          </SettingRow>
        )}
      </SettingsGroup>
      <DiagnosticsRows />
    </SettingsPaneView>
  );
}

function LanguageSelect({
  id,
  value,
  defaultLabel,
  onChange,
}: {
  id: string;
  value: string;
  defaultLabel: string;
  onChange: (value: string) => void;
}) {
  const items = [
    { value: "", label: defaultLabel },
    ...languages
      .map((code) => ({ value: code, label: languageName(code) }))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  ];
  // Keep a code saved elsewhere (or by a later build) selectable.
  if (!items.some((item) => item.value === value)) {
    items.push({ value, label: languageName(value) });
  }

  return (
    <ResponsiveSelect
      items={items}
      value={value}
      onValueChange={(next) => onChange(next ?? "")}
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-description`}
      className="w-44"
    />
  );
}

// A small set of mutually exclusive options, as a segmented control.
function Choice<T extends string>({
  id,
  value,
  options,
  labels,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  // On the phone a choice is a value and a chevron that opens a sheet (#137).
  if (useCompactShell()) {
    return (
      <ResponsiveSelect
        items={options.map((option) => ({ value: option, label: labels[option] }))}
        value={options.find((option) => option === value) ?? options[0]!}
        onValueChange={(next) => next && onChange(next)}
        aria-labelledby={`${id}-label`}
      />
    );
  }
  return (
    <ToggleGroup
      aria-labelledby={`${id}-label`}
      variant="outline"
      value={[value]}
      onValueChange={([pressed]) => {
        // Pressing the current option would clear the group; keep it.
        const next = options.find((option) => option === pressed);
        if (next) onChange(next);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option} className="px-3">
          {labels[option]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
