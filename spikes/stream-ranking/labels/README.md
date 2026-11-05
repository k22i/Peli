# Labels

`sample.jsonl` is the labelling sample drawn by `src/sample.ts`: 300 streams (comet-tb 90, torrentio 60, torrentio-tb 60, torrentsdb 55, peerflix 35), spread across the 20 titles. Every third one is in the **holdout** split, which the parser was not tuned against.

`labels.jsonl` holds one hand label per sampled stream. Labels were written by reading the stream's `name`, text and filename, **before** the parser existed and without running any parser over the sample. They record what the stream *claims* (a "2160p" label means the release says 2160p, not that the video was checked), except `fake`, which is a judgement.

An omitted field means `null`, `[]` or `false`. Where two answers are both defensible (the torrent says WEBRip and the file says WEB-DL; a release has two group tags), a field holds an array of acceptable values.

## Fields

| Field | Values | Rule |
|---|---|---|
| `res` | `2160p` `1440p` `1080p` `720p` `576p` `480p` `360p` or `null` | `4K` / `UHD` → `2160p`; `1280x720` → `720p`. The addon's `name` counts as a claim. `null` when nothing states it. |
| `hdr` | subset of `DV` `HDR10+` `HDR10` | Generic `HDR` → `HDR10`. `[]` for SDR or unstated. |
| `vcodec` | `hevc` `avc` `av1` `xvid` `mpeg2` `vc1` or `null` | x265 / H.265 / HEVC → `hevc`; x264 / H.264 / AVC → `avc`. |
| `audio` | `truehd` `dts-x` `dts-hd` `dts` `eac3` `ac3` `aac` `opus` `flac` `mp3` `lpcm` or `null` | The best track the text names. DDP / DD+ / E-AC3 → `eac3`; DD / AC3 → `ac3`; DTS-HD MA and Comet's "DTS Lossless" → `dts-hd`. |
| `ch` | `7.1` `5.1` `2.0` `1.0` or `null` | Channels of that track. |
| `atmos` | boolean | |
| `sizeGB` | number or `null` | The size the stream shows (GiB, as the addon prints it), or `videoSize / 2^30`. |
| `pack` | boolean | The shown size covers more than the one video that plays (a season / series / collection torrent where the file isn't singled out). |
| `source` | `remux` `bluray` `web-dl` `webrip` `hdtv` `dvd` `cam` `ts` `tc` `scr` `other` or `null` | BDRip / BRRip / BD / BDMux → `bluray`; bare `WEB` → `web-dl`; WEB-DLRip / NetflixRip → `webrip`; TeleSync / HDTS → `ts`; DCPRip, HDRip, etc. → `other`. |
| `group` | string or `null` | Release group as written (compared case-insensitively). Fansub groups in `[brackets]` count; site tags (`www.…`, `[EZTVx.to]`) and dubbing studios don't. |
| `langs` | ISO 639-1 codes, plus `multi` | Audio languages the stream claims: flags, words like `KOREAN`, `Castellano`, `ITA ENG`, and the language in Peerflix's name. `multi` is added whenever it says MULTi / Dual / Multi Audio; `Dual Audio` on anime → `multi` + `ja` + `en`. Flags are taken as shown even when they are probably subtitle languages, **except** where the text says the languages are subtitles (`Multi Subs`, `VOSTFR`, `Legendado`, `Subtitulado`). `[]` when unstated. This field is the least well defined. |
| `season`, `episode` | number or `null` | Of the file that plays. For anime with absolute numbering, `season` is `null`. Packs where the file isn't named: the season(s) stated, `episode: null`. |
| `cached` | `true` `false` `null` | Debrid cache marker; `null` for P2P addons. |
| `fake` | boolean | Would not play what was asked for: a different title or episode, a non-video file, a size impossible for the claimed quality, or a "4K / BluRay" claim for a film still only in cinemas. CAM / TS are **not** fake by this rule (they're real, just bad); they're judged through `source`. |
| `note` | string | Why, when something is odd. |

## Title-matching labels (#99)

`title-matching.jsonl` labels streams that `node src/record.ts matching` recorded from Torrentio, by reading their release names before the title check was changed. Only the fields the check needs are labelled: `fake` (as above: another film, a sequel or short, a collection's other file, an unrelated upload), `source` for CAM / TS / screener releases, and `localized`: a genuine release that names the film only in another language or spelling than the name asked for (*Cadena perpetua* for The Shawshank Redemption). A release that has the English name beside the local one (*Побег из Шоушенка / The Shawshank Redemption*), or in its file name, is not localized. The rows' ids are `torrentio/<slug>#<index>`, and `frontend/scripts/extract-title-matching-corpus.ts` appends them to the corpus as the `titles` split. The titles' aliases (`titles-matching.ts`) are written by hand, as stand-ins for TMDB's.
