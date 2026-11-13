# iOS playback coverage (Phase 5)

Real debrid streams played by the iOS engine (`internal/iosplayer`, ADR-0058) in the iOS 27.2 simulator on 2026-11-13: an iPhone 17 (`peli-p5-iphone`) and an iPad Pro 11-inch (`peli-p5-ipad`). It replaces the AVPlayer coverage gate: libmpv plays every container and codec we met, so coverage is about what the picture path does with each.

Sources: rows 1–10 are the coverage matrix, played on the iPhone through the dev hook (`PELI_DEV_PLAY`, guest profile, Torrentio with TorBox); rows 11–13 are the real UI flow (picker, player, menus, resume, next episode). Stream names are release names only; no URL, key or token is recorded here.

## How to read it

- **TTFF** is from `loadfile` to mpv's first `playback-restart`, so it includes the debrid redirect and the HTTP open. The simulator decodes and draws on a loaded host (load average 60–600 during these runs), so treat it as an upper bound.
- **hwdec** is the simulator's. The simulator can't map VideoToolbox frames at all, so it decodes HEVC with `videotoolbox-copy`; a device starts every file in zero-copy `videotoolbox` with `hwdec-image-format=nv12` (ADR-0058). H.264 has no VideoToolbox decoder in the simulator, so it decodes in software there. AV1 is software (dav1d) everywhere in this build.
- **Seek** is +120 s from the dev hook, `want` vs `got` once mpv settled, or the touch seek bar for rows 11–13.
- **Picture**: rows 1–10 ran before the 8-bit fix and before the simulator `glFinish`, so their screenshots were unreliable (black or half-drawn frames, see "Rendering findings"). "Checked after the fix" means the same file, or one with the same codec, bit depth and decode path, was seen drawing correctly with the fixed engine.

## Results

| # | Stream (addon) | Container, video | Audio | Subtitles | hwdec (sim) | TTFF | Seek | Picture |
|---|---|---|---|---|---|---|---|---|
| 1 | Dune.2021.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265 (Torrentio TB) | MKV, HEVC Main10 1920×1080, p010, SDR | E-AC-3 5.1 | 2 SRT (en selected) | copy | 3.8 s | 3137 → 3137 | landscape shot correct before the fix; same path as row 8 |
| 2 | Interstellar 2014 IMAX 1080p BRRip x264 DTS-JYK | MKV, H.264 1920×1080, yuv420p | DTS 5.1 | none | software | 8.3 s | 1632 → 1633 | 8-bit software: checked after the fix (fixture, row 12) |
| 3 | Interstellar (2014) AV1 1080p 7RIP | MKV, AV1 1920×800, yuv420p10 | AAC 2.0 | 9 SRT (en selected by language) | software (dav1d) | 8.2 s | 1632 → 1634 | 10-bit software: black before the fix; converted to 8-bit now (fixture checked) |
| 4 | Dune.2021.720p.WEBRip.x264.AAC-[YTS.MX].mp4 | MP4, H.264 1280×512, yuv420p | AAC 2.0 | none | software | 5.7 s | 3134 → 3137 | shown (portrait) |
| 5 | Dune (2021) BluRayRip 2160p 10bit x265 HEVC HDR10 TrueHD 7.1 | MKV, HEVC Main10 3840×1604, p010, PQ/BT.2020 | TrueHD 7.1 (+ AC-3) | PGS (en selected) | copy | 9.5 s | 3132 → 3132 | not re-captured; same path as row 8, tone-mapped by mpv's shaders |
| 6 | Dune - Part One (2021) 2160p H265 10 bit DV HDR10+ ita eng AC3 5.1 | MKV, HEVC Main10 3840×1604, p010, PQ (Dolby Vision with an HDR10 base layer) | AC-3 5.1 it / en (en selected by language) | 3 SRT (en selected) | copy | 9.9 s | 3130 → 3130 | not re-captured; plays the HDR10 base layer tone-mapped, the DV metadata is ignored |
| 7 | Dune.Part.One.2021.1080p.DS4K.BDRip.HDR10.HEVC.AAC.mSubs | MKV, HEVC Main10 1920×802, p010, PQ/BT.2020 | AAC 2.0 | 20+ SRT and PGS (PGS en selected) | copy | 10.0 s | 3130 → 3130 | not re-captured; tone-mapped |
| 8 | [YakuboEncodes] Cowboy Bebop 01 BD 1080p 10bit x265 (dual audio) | MKV, HEVC Main10 1448×1080, p010 | Opus 5.1 en / ja | ASS en / ja | copy | 11.5 s | 429 → 431 | **sheared before the fix; correct now** (`phase5-iphone-hevc10-1448.png`) |
| 9 | Cowboy Bebop S01 1080p Hi10p BluRay FLAC5.1 x264 [CTR] | MKV, H.264 High 10 1448×1080, yuv420p10 | FLAC 5.1 en / ja, AAC ja | 3 ASS (en selected) | software (no hardware Hi10p on any Apple device) | 9.8 s | 430 → 430 | 10-bit software: converted to 8-bit now (fixture checked) |
| 10 | Interstellar 2014 1080p NF WEB-DL DDP5.1 SDR AV1-OnlyWeb | MKV, AV1 1920×1080, yuv420p10 | E-AC-3 5.1 | SRT en / fr (en selected) | software (dav1d) | 6.8 s | 1633 → 1634 | as row 3 |
| 11 | Chernobyl 2019 S01E01 1080p BluRay x265 DDP 5.1 (Meteor, the user's own addon, on their signed-in profile) | MKV, HEVC Main10 1920×960, p010 | E-AC-3 5.1 | 1 SRT in the file, 97 from OpenSubtitles v3 | copy | 2.5 s | seek-bar taps to 23:29, 41:06, 43:08, 53:27, 56:41 | **correct after the fix** (`phase5-iphone-player.png`); an addon SRT shown (`phase5-iphone-subtitles.png`) |
| 12 | Breaking Bad S01 REMUX FullHD 1080p AVC (Torrentio TB, guest; iPhone, then iPad) | MKV, H.264 1920×1080 | AC-3 and DTS ×6 (ru, en, a commentary) | SRT, ASS and PGS | software | 14.0 s (iPhone), 5.1 s (iPad) | resumed at 2:06 and 2:50, Start over to 0:03, seek-bar taps to 10:10 and 56:05 | shown on both; the 19 GB remux (about 45 Mbit/s) buffered on the iPhone |
| 13 | Breaking Bad (2008) 1080p Blu-ray Dual Audio Hindi English (Torrentio TB, guest, iPad) | MKV, HEVC 1080p | AC-3 hi, AAC en | 2 SRT en | copy | 3.8 s | n/a | black in every shot on the iPad (taken within 2.5 min of the start, at a host load of 300–600); the iPad's test pattern took about a minute to appear in the same conditions |

Every file opened, decoded audio and seeked. Nothing needed `retrying in software`, and no file failed.

### Audio

E-AC-3, AC-3, DTS, DTS-HD (core), TrueHD 7.1, Opus 5.1, FLAC 5.1 and AAC all decode (FFmpeg) to the AudioUnit output, downmixed to the simulator's stereo. Atmos and DTS:X metadata are dropped (no passthrough on iOS). The audio menu switches tracks (Cowboy Bebop English → Japanese, `phase5-iphone-audio.png`).

### Subtitles

- **SRT**, in the file and from addons: rendered by libass. An OpenSubtitles v3 SRT picked in the menu was downloaded by Go (`Player.AddSubtitle`) and shown on Chernobyl.
- **ASS** (Cowboy Bebop): selected by language and rendered with styling, as in the spike.
- **PGS** (rows 5 and 7): selected by language. Rendering was shown with the spike's fixtures, not captured here.
- Track choice follows the profile's languages (`TrackProps`): rows 3, 6 and 7 picked English out of many. The guest profile has no audio language set, so files whose default-flagged audio is Russian or Hindi (rows 12 and 13) started in those; that's the desktop's rule too.

### HDR and Dolby Vision

HDR10 (rows 5 and 7) and the Dolby Vision file (row 6, an HDR10 base layer) play, tone-mapped to SDR by mpv's GLES shaders after the 8-bit conversion, so expect some banding in dark gradients. A Dolby Vision profile 5 file (no HDR10 base layer) would show wrong colours; none came up. Showing HDR is out of scope (ADR-0055), and the iOS ranking no longer prefers HDR.

## Rendering findings

Three picture bugs from the first matrix had separate causes, all found in the simulator:

1. **10-bit frames drew black or sheared.** iOS GLES 3.0 has no 16-bit normalised textures, so mpv falls back to integer textures for `p010` and `yuv420p10`, and those drew black (or garbage along the frame) in the simulator, from the copy path and from software decoding alike. Converting to 8-bit first fixed every case. On a device the zero-copy path asks VideoToolbox for `nv12` and never meets it; the copy and software paths convert with a lavfi `format` filter.
2. **Black after switching hwdec mid-file.** In the simulator a failed zero-copy mapping (`CVOpenGLESTextureCache` error -6683, which it returns for every VideoToolbox frame, 8-bit included) leaves its software GLES drawing broken frames until the simulator reboots, in new app processes too. The matrix started each file in zero-copy, so every run after the first failure was suspect. The simulator now starts in the copy mode; the device fallback can't be judged there.
3. **Black screenshots in portrait.** Two more causes: the page's theme code made the webview opaque again after the video host had made it transparent (fixed: the player screen keeps the window clear), and the simulator presented frames its renderer hadn't finished (fixed in the simulator only: `glFinish` before present).

Also seen once and not explained: one session on the iPhone kept showing the same streaky frame for 18 minutes of content while audio and subtitles moved on. It didn't recur after a relaunch (the same file, the same seeks), and mpv's counters showed frames being decoded and drawn.

### iPad

The same flow ran on the iPad (`phase5-ipad-*.png`): picker, play, controls, the audio menu (seven tracks, switched to English DTS), the file's English SRT shown, resume with Start over, the next-episode card with E2 prepared, and Back to the title. Its larger drawable (834×1210 points) is slower still in software: the first picture took up to a minute at a host load of 300–600, and software-decoded H.264 frames showed 1-pixel seams on a regular grid, which no HEVC frame or test pattern did. Both are taken to be the simulator's renderer; a device run should confirm.

## Simulator limits (not bugs)

- OpenGL ES runs in software: 270–600 ms a frame on the loaded host, so mpv drops most frames and playback looks like a slideshow. Judge smoothness only on a device.
- VideoToolbox has no H.264 decoder in the simulator, and its frames can't be mapped into GLES there.
- **A device run is owed** for: the zero-copy path with `nv12` output, the copy fallback, frame rate at 1080p and 2160p, the cost of the 8-bit conversion for AV1 and Hi10p, thermal behaviour, and whether integer textures draw correctly on Apple's GPU driver.
