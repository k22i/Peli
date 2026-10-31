import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import { SignOutDialog } from "@/components/account/sign-out-dialog";
import { LicencesDialog } from "@/components/settings/licences-dialog";
import { ServerDialog } from "@/components/settings/server-dialog";
import { TmdbDialog } from "@/components/settings/tmdb-dialog";
import { AniListDialog, SimklDialog } from "@/components/settings/tracking-dialogs";
import {
  SettingRow,
  SettingsNav,
  SettingsSection,
  type SettingsSectionInfo,
} from "@/components/settings/settings-section";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { addonsQuery } from "@/lib/addons";
import { appVersionQuery } from "@/lib/app-info";
import { contentDisclaimer } from "@/lib/disclaimer";
import { useCurrentProfile } from "@/lib/profile";
import { serverName, serverQuery } from "@/lib/server";
import {
  captionsModes,
  deviceSettingsQuery,
  languageName,
  languages,
  profileSettingsQuery,
  subtitleSizes,
  useSaveDeviceSettings,
  useSaveProfileSettings,
  type DeviceSettings,
  type ProfileSettings,
} from "@/lib/settings";
import { useTmdbKey } from "@/lib/tmdb";
import { trackingQuery, useDisconnectAniList, useDisconnectSimkl, useImport } from "@/lib/tracking";
import {
  formatBytes,
  torrentCacheQuery,
  torrentCacheSizes,
  Torrents,
  useClearTorrentCache,
} from "@/lib/torrent";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

// The few settings Sinag needs (#17), on one page; it should stay short rather
// than grow into a control panel. Reached from the profile menu, outside the
// six-item nav.
const settingsSections = [
  { id: "account", title: "Account & profiles" },
  { id: "addons", title: "Addons" },
  { id: "playback", title: "Playback" },
  { id: "subtitles", title: "Subtitles" },
  { id: "appearance", title: "Appearance" },
  { id: "integrations", title: "Integrations" },
  { id: "privacy", title: "Privacy" },
  { id: "about", title: "About" },
] as const satisfies readonly SettingsSectionInfo[];

type SectionId = (typeof settingsSections)[number]["id"];
const section = (id: SectionId) => settingsSections.find((s) => s.id === id)!;

function Settings() {
  const profile = useCurrentProfile();
  const profileId = profile.id;

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-gutter py-8">
      <SettingsNav sections={settingsSections} />
      <div className="flex min-w-0 flex-1 flex-col gap-section">
        <h1 className="font-heading text-title font-stretch-semi-expanded">Settings</h1>
        <AccountSection />
        {profileId === undefined ? (
          <Skeleton className="h-96 rounded-xl" />
        ) : (
          <ProfileSections profileId={profileId} />
        )}
        <AboutSection />
      </div>
    </div>
  );
}

function AccountSection() {
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
    <SettingsSection section={section("account")}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <ProfileAvatar profile={profile} className="size-9" />
        <div className="flex flex-col">
          <span className="text-sm font-medium">{profile.name}</span>
          <span className="text-sm text-muted-foreground">{status}</span>
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
    </SettingsSection>
  );
}

// Everything that needs the current profile's or the device's settings.
function ProfileSections({ profileId }: { profileId: number }) {
  const profileSettings = useQuery(profileSettingsQuery(profileId));
  const deviceSettings = useQuery(deviceSettingsQuery);
  const saveProfile = useSaveProfileSettings(profileId);
  const saveDevice = useSaveDeviceSettings();

  if (!profileSettings.data || !deviceSettings.data) {
    return <Skeleton className="h-96 rounded-xl" />;
  }
  const settings = profileSettings.data;
  const device = deviceSettings.data;
  const setProfile = (change: Partial<ProfileSettings>) =>
    saveProfile.mutate({ ...settings, ...change });
  const setDevice = (change: Partial<DeviceSettings>) =>
    saveDevice.mutate({ ...device, ...change });

  return (
    <>
      <AddonsSection profileId={profileId} />

      <SettingsSection section={section("playback")}>
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
        <SettingRow
          id="audio-language"
          label="Audio language"
          description="Played when a stream has it."
        >
          <LanguageSelect
            id="audio-language"
            value={settings.audioLanguage}
            defaultLabel="Original"
            onChange={(audioLanguage) => setProfile({ audioLanguage })}
          />
        </SettingRow>
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
        {/* #69: chapters first, IntroDB for files without them. */}
        <SettingRow
          id="skip-intros"
          label="Skip intros automatically"
          description="Skips intros and recaps without asking when Sinag knows where they are. Otherwise a button offers to skip them."
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
        {/* Off unless the user turns it on (#55, ADR-0040): peers see their
            IP address. */}
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
      </SettingsSection>

      <SettingsSection section={section("subtitles")}>
        <SettingRow id="subtitle-size" label="Size">
          <Choice
            id="subtitle-size"
            value={settings.subtitleSize}
            options={subtitleSizes}
            labels={{ small: "Small", medium: "Medium", large: "Large" }}
            onChange={(subtitleSize) => setProfile({ subtitleSize })}
          />
        </SettingRow>
        <SettingRow
          id="captions"
          label="Captions"
          description="Turn subtitles on by default. System follows your computer’s captions setting."
        >
          <Choice
            id="captions"
            value={settings.captions}
            options={captionsModes}
            labels={{ system: "System", on: "On", off: "Off" }}
            onChange={(captions) => setProfile({ captions })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection section={section("appearance")}>
        <SettingRow
          id="theme"
          label="Theme"
          description="System follows your computer’s light or dark mode. Applies to this device."
        >
          <ThemeSwitcher />
        </SettingRow>
      </SettingsSection>

      {/* Debrid keys stay with the addons (#54, ADR-0038), so this row only
          points there. */}
      <SettingsSection section={section("integrations")}>
        <SettingRow
          id="debrid"
          label="Debrid services"
          description="Set up TorBox, AllDebrid or Premiumize in a stream addon’s own settings, such as Torrentio’s or Comet’s. Sinag never asks for your debrid key."
        >
          <Link to="/addons" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Open addons
          </Link>
        </SettingRow>
        <TrackingRows profileId={profileId} settings={settings} onChange={setProfile} />
        <TmdbRow />
      </SettingsSection>

      {/* The setting is the consent only: diagnostics themselves are #90, and
          read it before sending anything. */}
      <SettingsSection section={section("privacy")}>
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
      </SettingsSection>
    </>
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
        <Select
          items={items}
          value={String(size)}
          onValueChange={(next) => next && onChange(Number(next))}
        >
          <SelectTrigger
            aria-labelledby="torrent-cache-label"
            aria-describedby="torrent-cache-description"
            className="w-28"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </SettingRow>
  );
}

// SIMKL and AniList (#71), connected per profile: kids profiles get
// neither. Their settings are the profile's.
function TrackingRows({
  profileId,
  settings,
  onChange,
}: {
  profileId: number;
  settings: ProfileSettings;
  onChange: (change: Partial<ProfileSettings>) => void;
}) {
  const connections = useQuery(trackingQuery(profileId)).data;
  const disconnectSimkl = useDisconnectSimkl(profileId);
  const disconnectAniList = useDisconnectAniList(profileId);
  const importNow = useImport(profileId);
  const [connecting, setConnecting] = useState<"simkl" | "anilist">();
  if (!connections) return null;

  const simkl = connections.simkl;
  const anilist = connections.anilist;
  // Turning an import on brings in what's there now.
  const setImport = (change: Partial<ProfileSettings>, on: boolean) => {
    onChange(change);
    if (on) importNow.mutate();
  };

  if (connections.kids) {
    return (
      <SettingRow
        id="trackers"
        label="SIMKL and AniList"
        description="Kids profiles don’t connect to trackers."
      />
    );
  }

  return (
    <>
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
            onChange={(simklAnime) => setImport({ simklAnime }, simklAnime && settings.simklImport)}
          />
        </>
      )}
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

function AddonsSection({ profileId }: { profileId: number }) {
  const addons = useQuery(addonsQuery(profileId));
  const count = addons.data?.length;

  return (
    <SettingsSection section={section("addons")}>
      <SettingRow
        id="addons"
        label="Installed addons"
        description={
          count === undefined
            ? "…"
            : count === 1
              ? "1 addon installed"
              : `${count} addons installed`
        }
      >
        <Link to="/addons" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Manage addons
        </Link>
      </SettingRow>
    </SettingsSection>
  );
}

function AboutSection() {
  const version = useQuery(appVersionQuery);

  return (
    <SettingsSection section={section("about")}>
      <SettingRow id="version" label="Version">
        <span className="font-mono text-meta text-muted-foreground">{version.data ?? "…"}</span>
      </SettingRow>
      {/* The welcome screen says the same (#39). */}
      <SettingRow id="disclaimer" label="Content" description={contentDisclaimer} />
      <SettingRow id="licences" label="Licences" description="Open-source licences and notices.">
        <LicencesDialog labelledBy="licences-label" />
      </SettingRow>
      <SettingRow id="design-system" label="Design system" description="Every token and component.">
        <Link
          to="/gallery"
          aria-labelledby="design-system-label"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Open
        </Link>
      </SettingRow>
    </SettingsSection>
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
    <Select items={items} value={value} onValueChange={(next) => onChange(next ?? "")}>
      <SelectTrigger
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="w-44"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
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
