import type { Media, Member, Party as PartyInfo, State as PartyState } from "@bindings/party";
import type { ProfileSettings } from "@bindings/store";

// A profile's settings as Go's store.DefaultProfileSettings has them, with
// changes on top. Tests build ProfileSettings from this rather than a literal
// of their own, so a new field breaks one fixture, not every test file that
// has one (#62, #98, #99 and #108 each did).
export const profileSettings = (changes: Partial<ProfileSettings> = {}): ProfileSettings => ({
  audioLanguages: [],
  subtitleLanguage: "",
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
  skipIntros: false,
  simklScrobble: true,
  simklImport: true,
  simklAnime: true,
  anilistProgress: true,
  anilistImport: true,
  animeInMoviesAndShows: false,
  animePosterAddon: "",
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
