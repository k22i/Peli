import type {
  ActivityEntry,
  Media,
  Member,
  Party as PartyInfo,
  Reaction,
  State as PartyState,
} from "@bindings/party";
import type { DeviceSettings, ProfileSettings } from "@bindings/store";

// A profile's settings as Go's store.DefaultProfileSettings has them, with
// changes on top. Tests build ProfileSettings from this rather than a literal
// of their own, so a new field breaks one fixture, not every test file that
// has one (#62, #98, #99 and #108 each did).
export const profileSettings = (changes: Partial<ProfileSettings> = {}): ProfileSettings => ({
  audioLanguages: [],
  subtitleLanguage: "",
  secondSubtitleLanguage: "",
  subtitleSize: "medium",
  subtitleStyle: {
    font: "sans",
    size: 100,
    color: "#FFFFFF",
    edge: "outline",
    backdrop: 60,
    lift: 0,
    bold: false,
    override: false,
  },
  captions: "system",
  autoSyncSubtitles: true,
  skipIntros: false,
  preferredQuality: "best",
  autoplayTopPick: false,
  stillWatchingAfter: 3,
  simklScrobble: true,
  simklImport: true,
  simklAnime: true,
  anilistProgress: true,
  anilistImport: true,
  animeInMoviesAndShows: false,
  animePosterAddon: "",
  hideSpoilers: false,
  picture: {
    preset: "standard",
    brightness: 0,
    contrast: 0,
    saturation: 0,
    gamma: 0,
    hue: 0,
    shadowLift: false,
  },
  picturePresets: [],
  framing: {
    fit: "fit",
    aspect: "auto",
    zoom: 0,
    panX: 0,
    panY: 0,
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    autoCrop: false,
    rotate: 0,
    flipH: false,
    flipV: false,
  },
  sound: { dialogueBoost: false, nightMode: false, equalizer: "flat" },
  gestures: { levelSwipes: true, seekSwipe: true, holdForSpeed: true, doubleTapSkip: 10 },
  ...changes,
});

// The device's settings as Go's store.DefaultDeviceSettings has them, with
// changes on top (the same idea as profileSettings, for the machine's).
export const deviceSettings = (changes: Partial<DeviceSettings> = {}): DeviceSettings => ({
  hardwareDecoding: true,
  maxResolution: "auto",
  hdr: "auto",
  dolbyVision: "auto",
  skipTimesOnline: true,
  diagnostics: false,
  torrentStreaming: false,
  torrentCacheGB: 5,
  preResolve: false,
  // Seek-bar previews: on, from the playing file alone.
  seekPreviews: true,
  previewsFromSmaller: false,
  streamSort: "best",
  quality: {
    scaling: "balanced",
    deband: "off",
    sharpen: 0,
    upscaler: "off",
    motionSmoothing: false,
    deinterlace: "auto",
    toneMapping: "auto",
    targetPeak: 0,
  },
  audio: { device: "auto", stereoDownmix: false, volumeBoost: false },
  autoUpdate: true,
  // The party beside the video (ADR-0051), off until it is asked for.
  partyDock: false,
  // Downloads (#85, ADR-0064): the default folder, a 50 GB cap, Wi-Fi only.
  downloadsDir: "",
  downloadsCapGB: 50,
  downloadsWiFiOnly: true,
  // Who's watching is asked at launch until the picker's "Don't ask again".
  skipProfilePicker: false,
  subtitles: {
    always: false,
    style: {
      font: "sans",
      size: 100,
      color: "#FFFFFF",
      bold: false,
      edge: "outline",
      backdrop: 60,
      lift: 0,
      override: false,
    },
  },
  ...changes,
});

// A watch party (ADR-0051) watching The Shawshank Redemption, hosted by Ana,
// as party.Service.State answers it.
export function partyState(party: Partial<PartyInfo> = {}, media: Partial<Media> = {}): PartyState {
  return {
    unavailable: "",
    busy: false,
    party: {
      id: "p1",
      code: "ABCDEF",
      memberId: "me",
      hostId: "ana",
      isHost: false,
      hostOnly: false,
      canControl: true,
      connected: true,
      maxMembers: 8,
      members: [partyMember({ id: "ana", name: "Ana", host: true })],
      media: {
        type: "movie",
        id: "tt0111161",
        videoId: "",
        season: null,
        episode: null,
        title: "The Shawshank Redemption",
        episodeTitle: "",
        description: "",
        poster: "",
        background: "",
        logo: "",
        source: null,
        ...media,
      },
      watching: false,
      paused: false,
      waiting: false,
      waitingFor: [],
      behind: false,
      behindMs: 0,
      sharing: false,
      shared: null,
      ...party,
    },
  };
}

export function partyMember(member: Partial<Member> = {}): Member {
  return {
    id: "a",
    name: "Ana",
    avatarUrl: "",
    avatarColor: "",
    host: false,
    you: false,
    status: "ready",
    watchingElse: false,
    behindMs: 0,
    ...member,
  };
}

// A reaction as `party.Service` emits it on `party:reaction` (ADR-0051's
// addendum): another member's, unless a test says otherwise. Nothing bursts
// on a click, so a test that wants confetti emits one of these.
export function partyReaction(reaction: Partial<Reaction> = {}): Reaction {
  return { emoji: "🔥", memberId: "m2", name: "Sam", mine: false, at: 0, ...reaction };
}

// One line of the party's activity log (party:activity): the host's pause,
// unless a test says otherwise. The member is the party's own host in
// partyState.
export function partyActivityEntry(entry: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "pb:ana:1",
    kind: "paused",
    memberId: "ana",
    name: "Ana",
    positionMs: 863000,
    rate: 1,
    title: "",
    at: Date.UTC(2026, 10, 23, 20, 0),
    mine: false,
    ...entry,
  };
}
