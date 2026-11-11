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
  ...changes,
});
