import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import { SignOutDialog } from "@/components/account/sign-out-dialog";
import { AudioLanguagesRow } from "@/components/settings/audio-languages";
import { DiagnosticsRows } from "@/components/settings/diagnostics-rows";
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
} from "@/components/settings/settings-section";
import { TmdbDialog } from "@/components/settings/tmdb-dialog";
import { UpdateRows } from "@/components/settings/update-rows";
import { AniListDialog, SimklDialog } from "@/components/settings/tracking-dialogs";
import { ThemeSwitcher } from "@/components/theme-switcher";
import {
  defaultSubtitleStyle,
  SubtitleStyleEditor,
  subtitlePreviewStyle,
  type SubtitleStyle,
} from "@/components/player/subtitle-panel";
import { Button, buttonVariants } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { posterAddons } from "@/lib/anime-posters";
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
import { appBuildQuery, appVersionQuery } from "@/lib/app-info";
import { contentDisclaimer } from "@/lib/disclaimer";
import { deviceName as hostName, isIOS } from "@/lib/platform";
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
  trackingQuery,
  useDisconnectAniList,
  useDisconnectSimkl,
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
  const { section = defaultPane } = Route.useSearch();
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
    case "plugins":
      return <PluginsPane title={title} profileId={profileId} />;
    case "tracking":
      return <TrackingPane title={title} profileId={profileId} />;
    case "appearance":
      return <AppearancePane title={title} />;
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
      ? "Signed in. Your Nuvio profiles sync across devices; the Guest profile stays on this one."
      : "Signed in. Your library, progress and addons sync across devices."
    : profile.sessionEnded
      ? "Your session ended. Sign in again to keep syncing; your library and progress here are kept."
      : "Sign in to sync your library, progress and addons across devices.";

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
                : "Nuvio’s server. You can use your own Nuvio-compatible server instead."
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
        <SettingRow
          id="profiles"
          label="Profiles"
          description="Add, rename and delete profiles, and change their avatars."
        >
          <Link
            to="/profiles"
            search={{ manage: true }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Manage
          </Link>
        </SettingRow>
      </SettingsGroup>
    </SettingsPaneView>
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
                description="Set up TorBox, AllDebrid or Premiumize in a stream addon’s own settings, such as Torrentio’s or Comet’s. Peli never asks for your debrid key."
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
                description="Off: anime that general addons list among films and series shows only under Anime."
              >
                <Switch
                  aria-labelledby="anime-in-movies-and-shows-label"
                  aria-describedby="anime-in-movies-and-shows-description"
                  checked={settings.animeInMoviesAndShows}
                  onCheckedChange={(animeInMoviesAndShows) => setProfile({ animeInMoviesAndShows })}
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
  return (
    <SettingsPaneView title={title}>
      <WithSettings profileId={profileId}>
        {({ settings, device, setProfile, setDevice }) => (
          <>
            {/* mpv's picture, sound and HDR controls aren't in the iOS app
                (ADR-0055). */}
            {feature("playerPanels") && (
              <>
                <SettingsGroup title="Video">
                  <SettingRow
                    id="hardware-decoding"
                    label="Hardware decoding"
                    description="Decodes video on the graphics card, which saves power. Turn it off if playback stutters or shows glitches. Applies to this device, from the next video you play."
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
                    description="How HDR video is brought into what this screen shows, when it can't show HDR. Natural keeps it true to the film; Bright lifts it; Filmic is softer at the top. Applies to this device."
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
                    description="How bright this screen gets, for tone mapping. Auto lets the player guess; a brighter value keeps more of the highlights."
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
                <PictureDefaults
                  profileId={profileId}
                  settings={settings}
                  setProfile={setProfile}
                />
                <SettingsGroup title="Framing">
                  <SettingRow
                    id="framing-fit"
                    label="Fit"
                    description="How the picture fills the window: all of it, the window filled (the edges cropped), stretched, or its own size. A title can have its own (P, then Framing, or Shift+F)."
                  >
                    <Choice
                      id="framing-fit"
                      value={settings.framing?.fit ?? "fit"}
                      options={fitModes.map(({ id }) => id)}
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
                    description="Finds the bars around a film as it plays and crops them, so a wide film fills a wide screen. It never cuts into the picture."
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
              </>
            )}
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
                label="Ask if you’re still watching"
                description="After this many episodes in a row with no key or pointer touched, the next one waits until you say you’re still there."
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
                description="Skips intros and recaps without asking when Peli knows where they are. Otherwise a button offers to skip them."
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
                description="Asks IntroDB (introdb.app) where they are, for videos that don’t mark them, which tells it what you’re watching. Applies to this device."
              >
                <Switch
                  aria-labelledby="skip-times-online-label"
                  aria-describedby="skip-times-online-description"
                  checked={device.skipTimesOnline}
                  onCheckedChange={(skipTimesOnline) => setDevice({ skipTimesOnline })}
                />
              </SettingRow>
            </SettingsGroup>
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
        "Swipe up or down on the left of the picture for brightness, on the right for volume.",
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
        description="How far a double tap on either side of the picture, and the skip buttons, go."
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
  const devices = useQuery({
    queryKey: ["player", "audio-devices"],
    queryFn: async () => (await Player.AudioDevices()) ?? [],
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
      <SettingRow
        id="audio-device"
        label="Output"
        description={`Where the player's sound goes. System default follows the ${isIOS() ? "device" : "Mac"}'s sound settings. Applies to this device.`}
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
      <SettingRow
        id="stereo-downmix"
        label="Stereo downmix"
        description="Mixes surround tracks down to two channels, for stereo speakers and headphones. Applies to this device."
      >
        <Switch
          aria-labelledby="stereo-downmix-label"
          aria-describedby="stereo-downmix-description"
          checked={audio.stereoDownmix}
          onCheckedChange={(stereoDownmix) => setAudio({ stereoDownmix })}
        />
      </SettingRow>
      <SettingRow
        id="volume-boost"
        label="Volume up to 150 %"
        description="For quiet tracks. Above 100 % loud parts can distort. Applies to this device."
      >
        <Switch
          aria-labelledby="volume-boost-label"
          aria-describedby="volume-boost-description"
          checked={audio.volumeBoost}
          onCheckedChange={(volumeBoost) => setAudio({ volumeBoost })}
        />
      </SettingRow>
      <SettingRow
        id="dialogue-boost"
        label="Dialogue boost"
        description="Lifts speech over music and effects in every title, unless one has its own (B in the player). Surround sound comes out of the front while it's on."
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
        description="Evens out loud and quiet, for watching late without waking anyone."
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
  return (
    <>
      <SettingRow
        id="scaling"
        label="Scaling"
        description={`${scalingHint[quality.scaling] ?? ""} Applies to this device.`}
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
        description="Smooths the steps in skies and dark gradients. High can soften fine texture."
      >
        <Choice
          id="deband"
          value={quality.deband}
          {...choices(debandLevels)}
          onChange={(deband) => setQuality({ deband })}
        />
      </SettingRow>
      <SettingRow
        id="sharpen"
        label="Sharpening"
        description="AMD's contrast-adaptive sharpening: crisper detail without halos."
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
      <SettingRow
        id="motion-smoothing"
        label="Motion smoothing"
        description={`Shows frames in step with the screen and blends between them: smoother pans, but films can look like TV (the soap-opera look). Uses more power. ${heavyWarning({ ...quality, motionSmoothing: true }) ?? ""}`}
      >
        <Switch
          aria-labelledby="motion-smoothing-label"
          aria-describedby="motion-smoothing-description"
          checked={quality.motionSmoothing}
          onCheckedChange={(motionSmoothing) => setQuality({ motionSmoothing })}
        />
      </SettingRow>
      <SettingRow
        id="deinterlace"
        label="Deinterlacing"
        description="For TV recordings and DVDs. Auto only deinterlaces video marked as interlaced."
      >
        <Choice
          id="deinterlace"
          value={quality.deinterlace}
          {...choices(deinterlaceModes)}
          onChange={(deinterlace) => setQuality({ deinterlace })}
        />
      </SettingRow>
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
        description="How every title looks unless you adjust it in the player (P). Changes made there stay with that title; Use for all titles there makes them this."
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
            : `${adjusted} ${adjusted === 1 ? "title keeps its" : "titles keep their"} own picture, framing or quality, on this device.`
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

// Where the Anime tab's posters come from: AniList's covers, or an addon's
// posters (BetterPosters, Xperience…) where an entry is one title to it.
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
    { value: "", label: "AniList covers" },
    ...posterAddons(addons).map((addon) => ({ value: addon.url, label: addon.manifest.name })),
  ];
  // An addon since removed: keep it showing until something else is picked.
  if (!items.some((item) => item.value === value)) items.push({ value, label: "Removed addon" });
  return (
    <SettingRow
      id="anime-posters"
      label="Anime posters"
      description="The Anime tab’s list stays AniList’s. An addon’s posters show for films and single-season shows; later seasons and split cours keep AniList’s cover, since a show’s poster would stand for none of them."
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

// How subtitles look: a sample line in the profile's style, and the
// player's own editor in a dialog. The player saves its changes here too.
function SubtitleLookRow({
  style,
  onChange,
}: {
  style: SubtitleStyle;
  onChange: (style: SubtitleStyle) => void;
}) {
  const [draft, setDraft] = useState<SubtitleStyle>();
  return (
    <SettingRow
      id="subtitle-look"
      label="Look"
      description="Font, size, colour, edge and position. You can change it while you watch, too."
    >
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
        {({ settings, setProfile }) => (
          <>
            <SettingsGroup title="Languages">
              <AudioLanguagesRow
                value={audioLanguagesOf(settings)}
                onChange={(audioLanguages) => setProfile({ audioLanguages })}
              />
              <SettingRow
                id="subtitle-language"
                label="Subtitle language"
                description="Chosen when a stream or subtitle addon has it."
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
                description="Shown smaller, above the main subtitles, when a stream or subtitle addon has it."
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
                style={settings.subtitleStyle?.font ? settings.subtitleStyle : defaultSubtitleStyle}
                onChange={(subtitleStyle) => setProfile({ subtitleStyle })}
              />
              <SettingRow
                id="captions"
                label="Captions"
                description={`Turn subtitles on by default. System follows your ${hostName()}’s captions setting.`}
              >
                <Choice
                  id="captions"
                  value={settings.captions}
                  options={captionsModes}
                  labels={{ system: "System", on: "On", off: "Off" }}
                  onChange={(captions) => setProfile({ captions })}
                />
              </SettingRow>
            </SettingsGroup>
          </>
        )}
      </WithSettings>
    </SettingsPaneView>
  );
}

function StreamingPane({ title, profileId }: { title: string; profileId: number | undefined }) {
  return (
    <SettingsPaneView title={title}>
      <WithSettings profileId={profileId}>
        {({ device, setDevice }) => (
          <>
            <QualityGroup device={device} onChange={setDevice} />
            <SettingsGroup title="Starting">
              {/* Off unless the user turns it on (#101, ADR-0060): resolving
              ahead adds the stream to the debrid service's list. */}
              <SettingRow
                id="pre-resolve"
                label="Start cached streams sooner"
                description="Gets the top pick ready while you choose, when it’s cached on your debrid service, so it starts about two seconds sooner. This adds the stream to your debrid service’s list before you press play, even if you never play it. Off unless you turn it on. Applies to this device."
              >
                <Switch
                  aria-labelledby="pre-resolve-label"
                  aria-describedby="pre-resolve-description"
                  checked={device.preResolve}
                  onCheckedChange={(preResolve) => setDevice({ preResolve })}
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
                  description="Plays torrents without a debrid or direct link by fetching them from other people as you watch (peer to peer). They can see your IP address, and get pieces of the file from you too. Off unless you turn it on. Applies to this device."
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

// What this device shows (#98, ADR-0048), for choosing between streams: the
// ranking's weights stay out of sight, so these say what the screen can do. A
// stream that doesn't fit is listed after the ones that do, never hidden.
function QualityGroup({
  device,
  onChange,
}: {
  device: DeviceSettings;
  onChange: (change: Partial<DeviceSettings>) => void;
}) {
  return (
    <SettingsGroup title="Picture">
      <SettingRow
        id="max-resolution"
        label="Maximum resolution"
        description="The biggest picture to pick. Streams above it are listed after the rest. Auto doesn’t limit it. Applies to this device."
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
            description="Prefers HDR streams if this screen shows them. Auto asks the screen. Applies to this device."
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
            description="Prefers Dolby Vision streams, even ones with no HDR layer to fall back on. Auto leaves it off, as Peli can’t tell if this screen shows it. Applies to this device."
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

function AppearancePane({ title }: { title: string }) {
  return (
    <SettingsPaneView title={title}>
      <SettingsGroup>
        <SettingRow
          id="theme"
          label="Theme"
          description={`System follows your ${hostName()}’s light or dark mode. Applies to this device.`}
        >
          <ThemeSwitcher />
        </SettingRow>
      </SettingsGroup>
    </SettingsPaneView>
  );
}

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
              description="Sends crash reports and whether videos started playing, to help fix problems. Never your library, accounts or stream links. Off unless you turn it on. Applies to this device."
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
      description={`Keeps what you stream on this device, up to this size, deleting the oldest first. ${
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
          : "Keep SIMKL and AniList up to date with what this profile watches. Each profile connects its own accounts.")
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
  const importNow = useImport(profileId);
  const [connecting, setConnecting] = useState<"simkl" | "anilist">();
  if (!connections) return <Skeleton className="h-48 rounded-2xl" />;
  if (connections.kids) return null;

  const simkl = connections.simkl;
  const anilist = connections.anilist;
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
                  ? `Connected as ${simkl.user}, but SIMKL stopped accepting the sign-in. Connect again.`
                  : `Connected as ${simkl.user}. What this profile watches is scrobbled to SIMKL, and marked watched at 90 %.`
                : "Scrobble what this profile watches to SIMKL, and bring in your SIMKL history."
          }
        >
          {connections.simklAvailable && (
            <div className="flex items-center gap-2">
              {simkl && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Disconnect SIMKL"
                  loading={disconnectSimkl.isPending}
                  onClick={() => disconnectSimkl.mutate()}
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
              description="Shows SIMKL what’s playing, and marks it watched there when it’s finished."
              checked={settings.simklScrobble}
              onChange={(simklScrobble) => onChange({ simklScrobble })}
            />
            <ToggleRow
              id="simkl-import"
              label="Import watched history"
              description="Marks what you watched on SIMKL as watched here, and in Nuvio. Nothing here is unmarked."
              checked={settings.simklImport}
              onChange={(simklImport) => setImport({ simklImport }, simklImport)}
            />
            <ToggleRow
              id="simkl-anime"
              label="Include anime"
              description="Turn off if you keep anime on AniList instead."
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
                  ? `Connected as ${anilist.user}, but the sign-in has run out. Connect again.`
                  : `Connected as ${anilist.user}. Anime this profile watches moves along on your list.`
                : "Update your AniList list as you watch anime, and bring in what’s on it."
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
                  onClick={() => disconnectAniList.mutate()}
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
              description="Moves the list’s progress on when an episode is watched, and completes it at the last."
              checked={settings.anilistProgress}
              onChange={(anilistProgress) => onChange({ anilistProgress })}
            />
            <ToggleRow
              id="anilist-import"
              label="Import list"
              description="Marks the episodes on your AniList list as watched here, and in Nuvio."
              checked={settings.anilistImport}
              onChange={(anilistImport) => setImport({ anilistImport }, anilistImport)}
            />
          </>
        )}
      </SettingsGroup>
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
              ? "Title pages show TMDB’s logos, backdrops and cast photos. Applies to this device."
              : "Add your own TMDB key for richer artwork, logos and cast photos. Optional."
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
