---
status: accepted
date: 2026-10-30
---

# The player service: one mpv session per playback, three events, a host per OS

#60 builds what ADR-0001 and ADR-0002 decided: libmpv in-process, with its video under the transparent webview in the app window. This ADR records the shape of the Go service, the event contract the React controls (#61) build on, and what the first real runs of each host showed.

## Layout

| File | |
|---|---|
| `internal/player/mpv.go` | The cgo binding to `mpv/client.h`, from the spikes. A live-handle count for tests |
| `internal/player/player.go` | `Service`: `Load`, `SetPaused`, `Seek`, `Scrub` (keyframe seek, for dragging; #61), `SeekBy`, `SetVolume`, `SetMuted`, `SetSpeed`, `SetAudioTrack`, `SetSubtitleTrack`, `SetSubtitleDelay`, `SetSubtitleSize` (#62), `SetFullscreen`, `SetMini` (#70), `Stop`, `Snapshot`; the event loop |
| `internal/watching/watching.go` | `Reporter` (#64): the player's progress reports become the profile's progress and watched marks, and ask the push loop to send them |
| `internal/player/media.go`, `media_{darwin.go,darwin.m,linux.go,windows.go}` | The OS's media controls (#67): Now Playing and the remote commands on macOS, MPRIS on Linux, libmpv's own SMTC on Windows |
| `internal/player/captions_{darwin,other}.go` | The OS's captions preference (#62): MediaAccessibility on macOS, none elsewhere |
| `internal/player/mini_{darwin.go,darwin.m,other.go}` | The mini player (#70): the window made small and kept on top, natively on macOS, with Wails' window calls elsewhere |
| `internal/player/host.go` | The `host` interface each OS implements, and `nullHost` (no video or audio output) for tests |
| `host_darwin.go`, `video_darwin.m` | macOS: a `CAOpenGLLayer` view below the `WKWebView`, drawn on our own serial queue; half-float and EDR for HDR (#66) |
| `host_linux.go`, `video_linux.c` | Linux (X11 and Wayland): `gltex`, textures rendered on our own thread, shown by a `GtkPicture` below the webview |
| `host_windows.go` | Windows: `wid`, mpv's child window at `HWND_BOTTOM`, disabled |
| `frontend/src/lib/player.ts` | `usePlayerState` (snapshot, then events), `usePlayerEnded`, `reloadExpired`, `loadOptions` and `trackLabel` (#62) |
| `frontend/src/components/player/player-page.tsx`, `seek-bar.tsx` | The `/player` screen and its controls (#61) |
| `frontend/src/components/player/shortcuts.tsx` | The keys and their help overlay (#67) |

## A session is one mpv handle

`Load` opens a session if none is open: `mpv_create`, the options, the host's options (`vo`, `wid`), `mpv_initialize`, the property observers, the event loop, then the host's surface and render context, **before the first `loadfile`**. A second `Load` replaces the file in the same session (`loadfile … replace`). `Stop`, leaving the player screen and app shutdown close it in the order the M0 binding rules give: a flag, `mpv_wakeup`, join the event loop, free the render context on the render thread, remove the surface on the UI thread, then `mpv_terminate_destroy`.

We chose one handle per playback over one for the app's life: nothing of mpv's lingers between films, a broken state can't carry over, and the "no leaked handles" check is a counter that must read 0. Opening costs single-digit milliseconds (M0, #3). A test opens and closes 10 sessions and checks the handle count and the goroutines. On macOS 22 sessions in the app brought the thread count back to its idle value each time.

No libmpv call runs on the UI thread. Bound methods run on Wails' goroutines, the hosts move only their widget work onto the UI thread, and every render call happens on a render thread or queue of our own.

## Loading a stream

`Load(source, {start})` takes the `Source` that resolving returns (ADR-0037). It sets `user-agent` (the addon's or Peli's) and `http-header-fields` **as a list** (`mpv_node` array), since a header value may hold a comma. `start` is a per-file `loadfile` option. HLS segments get the same headers: a test serves a playlist and its segments only to requests that carry them.

Every session sets: `idle`, `force-window=no` (with `vo=libmpv`, a forced window would start a VO before the render context exists), `keep-open=no`, no OSC, OSD, scripts or `ytdl` (no youtube-dl subprocess for an HTTP link), no mpv input handling (the webview gets every click and key), black background, and `hwdec` from Settings (#66, below). `$PELI_MPV_OPTIONS` (`"gpu-sw hwdec=no"`) overrides them, for debugging and for GPU-less CI and containers.

## The event contract

| Event | Payload | When |
|---|---|---|
| `player:state` | `State`: `active`, `loading`, `paused`, `buffering`, `bufferPercent`, `seeking`, `position`, `duration`, `buffered`, `volume`, `muted`, `speed`, `fullscreen`, `tracks`, `hwdec`, `subtitleDelay`, `subtitleSize` (#62), `hdr` (#66) | Whenever anything but the time changes |
| `player:time` | `Time`: `position`, `duration`, `buffered` (seconds of cache ahead) | At most every 250 ms while playing, and at once after the first frame or a seek |
| `player:ended` | `Ended`: `reason` `eof` or `error`; for errors `code` `expired`, `unsupported` or `failed`, and mpv's `message` | The file ended by itself. `Stop` and loading another file send nothing |

Times are in seconds. All three are registered with `application.RegisterEvent`, so the bindings type them. `Snapshot()` returns the same `State`: events sent before a page listens arrive late (3–7 s on Windows CI in M0), so the page reads a snapshot when it mounts and applies events after it.

This merges the spikes' `player:tracks`, `player:buffering` and name/value `player:state` into one `State`. One shape is simpler for React than five, and a burst of property changes (a load sets a dozen) becomes **one** event: the loop handles every event waiting, then sends what changed. `player:time` stays separate and throttled, because a re-render per frame cost ~10 % CPU in WebKit (M0, #4).

**`expired`** comes from FFmpeg's "HTTP error 401/403/404/410" log line. The client has to ask for log messages at `v`: at `warn`, libmpv drops that line. libmpv also sends FFmpeg's log to only one mpv instance per process. The app has one at a time, but the test for it can't run in parallel with the others. On `expired`, the player screen asks the addon's link again (`Resolve(origin)`, ADR-0037) and loads the new one from the position it stopped at, at most once a minute.

## Tracks and subtitles (#62)

`Load` also takes the profile's `audioLanguage` and `subtitleLanguage` (ISO 639 codes, "" for the file's default), `captions` and `subtitleSize`. It sets them as properties before `loadfile`, and mpv picks the tracks. We tried mpv 0.41 on a file with a default-flagged, a second-language and a forced subtitle track (`testdata/tracks.mkv`). These settings give the behaviour we want:

| Captions | mpv | Shows |
|---|---|---|
| on | `sid=auto`, `slang=<language>`, `subs-fallback=yes`, `subs-fallback-forced=no` | Full subtitles in the language, or else the default or first track. Never the forced track when a full one exists |
| off | `sid=auto`, `slang=`, `subs-fallback=no`, `subs-fallback-forced=yes` | Forced subtitles (signs, foreign dialogue) in the audio's language only. `sid=auto` alone shows a default-flagged track when the audio is in another language |
| system | on or off, as the OS asks | |

Every session also sets `subs-match-os-language=no`, so a language left "" means the file's default, not the OS language. Two-letter codes match three-letter tags (`ja` picks `jpn`).

**System** reads MediaAccessibility on macOS: captions are on when the display type is "always on", or when the preferred captioning characteristics include transcribed dialogue ("Prefer closed captions and SDH"). Windows' captions settings only style captions, and Linux desktops have no such setting, so System means off there and the profile's On turns captions on.

The player screen has an Audio menu (two or more tracks: language, codec, channels) and a Subtitles menu (Off and each track, marked Forced, SDH or External; Small/Medium/Large; timing in 0.1 s steps, also on Z and X). The size the user picks is saved as the profile's `subtitleSize`, as Settings saves it. Timing isn't saved: a delay fixes one release's subtitles, and as a profile default it would put every other file out of sync. It lasts for the session, so a retry or a fresh link keeps it. A retry or a fresh link also loads with the languages of the tracks that were playing, so tracks picked by hand stay picked. mpv keeps `sub-delay` as a float32, so the state rounds it to milliseconds.

## Addon subtitles (#63)

The player screen asks every enabled addon that serves `subtitles` for the video (not limited for a kids profile, like streams), with the `filename`, `videoSize` and `videoHash` extras the picked stream gives, which help OpenSubtitles match the release. Subtitles in the stream's own answer come first. The Subtitles menu lists them under "From addons", one submenu per language: the profile's language first, then by name. OpenSubtitles' codes are ISO 639-2 plus a few of its own (`pob` is Brazilian Portuguese), read with `Intl.Locale`.

`Service.AddSubtitle({url, lang, title})` downloads the file in Go (Peli's User-Agent, 30 s, 16 MiB, gzip unpacked), writes it to a temporary folder kept until the session closes, and runs `sub-add <file> select <title> <lang>`. It returns the new track's id, and the track shows in the menu as External. Go downloads it rather than mpv, because mpv would send the stream's `http-header-fields` (an addon's proxy headers) to the subtitle server too. Loading a file drops its external tracks, so after a retry or a fresh link the screen adds the addon subtitles that were showing again.

When captions are on (or System, and the OS asks for them: `Service.SystemCaptions`) and the file has no full subtitles in the profile's language, the first addon subtitle in that language is added by itself, once per file. Picking subtitles in the menu (the file's own or an addon's, but not forced ones) saves their language as the profile's `subtitleLanguage`, so the next file starts in it. Captions on or off stays a Settings choice: Off in the menu turns subtitles off for this file only.

## Progress, resume and watched (#64)

**Go keeps the progress, not the screen.** `LoadOptions.watching` names the film or episode a file plays (profile, content id and type, video id, season and episode, and the name its watched item takes). `player.ReportTo` hands the service a `Report` (position, duration, why) every `ReportEvery` (10 s) while it plays, when it pauses, lands after a seek, ends by itself (played to the end counts as the whole duration), and when it is stopped or replaced by another `Load`. That covers leaving the screen, and quitting the app: the player shuts down before the syncer, which sends the last report on its way out. A file still loading, or with no known length (live), reports nothing, so a start position asked for is never saved as one reached. We chose Go over a React hook because a quit or a closed window never runs the screen's cleanup, and the position at the moment of stopping is the one the user expects on the other device.

`watching.Reporter` writes each report with `Store.SaveProgress` (ms, a fresh `lastWatched`, Nuvio's key `<id>_s<season>e<episode>`). The push loop already holds progress to one push per entry every 30 s (ADR-0017), so a periodic report only saves. A pause, seek, end or stop also calls `Pusher.FlushProgress`, in the background and one at a time (a burst of seeks becomes one more push), so the position where playback stopped leaves at once, outside the server's 30 s and 15 s thresholds most of the time.

**Watched at 90 %, as the server counts it.** At 90 % of an item of at least a minute the reporter marks it watched (`Store.MarkWatched`), unless it is marked already, so playing on or watching again queues nothing more. That is the server's own rule (M0 gotcha 2): the finished progress makes the server create the same item, so Peli's mark must not reach it as a second push. `FlushProgress` is the new push mode for this: like a flush it ignores the 30 s hold and the backoff, but a watched upsert still waits out `WatchedGrace` behind its finished progress and is then settled by the pull (ADR-0017). The app's exit flush uses it too, since the outbox outlives the app; only the sign-out flush still sends everything. The progress stays (finished), as the server keeps it, so Continue Watching drops the item by its 90 % rule and the title page counts it watched either way. Files under a minute are never marked, as on the server. A series' own mark isn't touched: the title page derives "series watched" from the episodes, and reconciles the series mark on the next edit there (ADR-0029).

**Resume from the store, as synced.** The stream picker pulls when it opens (Go skips it inside its 30 s throttle), and when a stream is picked it reads the title's progress from the store afresh (`titleProgressQuery`, `staleTime: 0`) rather than trusting the card that opened it: another device may have moved it on. `watchingFor` names the episode from the title's details, else its progress, else its id (`tt…:2:4`); `resumePoint` returns its unfinished position, or 0 at or past 90 %. Only if the store can't answer does the card's `resumeAt` stand. The player screen gets `watching` and `resumedAt` in history state, passes `watching` to every `Load` (retries and fresh links too), and, for a file that resumed, shows "Resumed at 23:14 · Start over" for its first 10 s of playing; Start over seeks to 0, which the next report saves. Leaving the screen invalidates the progress and watched queries once `Stop` has returned, by which time Go has saved where it stopped.

A guest's reports and marks stay local: the store queues no push for an unlinked profile, so the flushes send nothing (`TestGuestReportsMakeNoNuvioRequests`, #23's check for playing and resuming).

## Next episode (#65)

**The countdown starts where the episode counts as watched.** Once a series episode reaches 90 % of at least a minute (`countdownFrom`, the same point Go marks it watched), a card offers the next episode, `nextEpisode`: the next one out in order, outside Specials, as Play on the title page goes. None is offered for a film, after the last episode out, or for a special. The card counts down to the end of the file rather than for a fixed few seconds, so nothing is cut short. Where the credits are known (#69) and start after the watched mark, the card waits for them, so it doesn't cover the last scene; it never shows before the mark, since Play now would leave the episode unwatched. When the file ends the next episode plays. Play now plays it at once, and Cancel leaves the screen at the end as before. Seeking back before the 90 % mark hides the card.

**Its stream is ready in advance.** While the card shows, `usePreparedNext` asks every stream addon for the next episode, ranks the answers as the picker does, takes the top pick once the ranking has been still for half a second, and resolves its link (`resolvePick`), so playing it means a `Load` and nothing else. Torrents are not opened in advance. internal/torrent plays one torrent at a time, so opening the next one would stop the one playing, and it would start peer traffic for an episode the user may cancel. A torrent pick (or a pick whose linked copies didn't resolve but which has torrent copies) is opened when it plays. If no stream is found, or the pick won't open, the stream picker for the next episode replaces the player. Resolving a debrid link in advance can add the torrent to the user's debrid list even if they cancel (ADR-0037). Once #58 remembers a show's source, the remembered one should go first here as in the picker.

**One session, a new file.** The next episode loads into the open session. Go reports the finished file as stopped when the new `Load` replaces it, so its 90 % mark stays. It gets its own `watchingFor(...)` and `resumePoint` read from the store, and the languages playing now (`loadOptions` with the tracks playing). The screen then replaces its history entry with the new heading, source, `watching`, `resumedAt` and subtitle target. `PlayerPage` owns the session (Stop on leaving, releasing a torrent) and renders the file's screen keyed by its source URL, so everything per file starts afresh: the error, Start over, the addon subtitles added, and the card. Ended events are ignored while the next file opens: opening a torrent can make the playing file fail first. A torrent playing is released once a linked next episode has loaded. Another torrent's `Open` drops it, and the next file of the same torrent (a season pack) now replaces the file the session serves (`session.file` is an atomic pointer) instead of returning the first one again.

## Stream switcher (#68)

**The picker's list, over the video.** A Streams button in the controls (and S) opens a side panel with the film's or episode's streams, asked for and ranked exactly as the picker does: `useStreamChoices` (from `streams-page.tsx`) is the picker's own hook, and the panel renders the same `StreamList`, summary and addon pills, P included. The addons are asked while the panel is open, usually answered from the picker's cache; closing it aborts what's still out, as leaving the picker does. The stream playing is marked "Playing": the history state now keeps the addon's `stream` it came from (the picker and the next episode set it), matched with `sameStream`, so another copy of the same file is marked too. The panel needs `watching` (what's playing): without it there's no button. While it's open the player's keys are the list's, and the controls stay shown.

**Another stream, from where this one is.** A pick resolves as the picker's does (`resolvePick`: the pick, then its copies, a new link on `expired`). The position is read from Go (`Snapshot`) once the link is ready, since the file plays on while it resolves; after a failed file, it's where that one stopped. The new file loads into the open session with the same `watching` and the languages playing now, and the screen replaces its history entry with the new source, stream and subtitle target, like the next episode (#65): Go reports the old file as replaced, at the same position, so progress carries on, and the file's screen starts afresh (its `resumedAt` is 0, so no Start over). A torrent playing is released once a linked stream has loaded; another torrent's `Open` drops it itself. Picking the stream playing just closes the panel. A pick that can't be opened says why in the panel (`PlayError`'s text) and leaves the playing file alone. A failed file's "Choose another stream" opens the panel instead of going back to the picker, when the screen knows what plays.

**Checked:** route tests cover the list and its mark, S, the keys while open, the pick from the current position, a failure, a pick after a failed file and a torrent let go. **Not checked:** in the app (no live check of this ticket).

## Skip intro and credits (#69)

**Two sources: the file's chapters, then IntroDB.** Go observes mpv's `chapter-list` into `State.chapters` (title and start). A chapter whose whole name is an intro ("Intro", "OP", "Opening", "Main Titles"), a recap ("Recap", "Previously on…") or credits ("Credits", "End Credits", "ED", "Ending", "Outro") runs to the next chapter, or the end of the file. Whole names only, after lowercasing and dropping punctuation and a trailing number, so "Opening Night" stays part of the story. A file whose chapters name none of these asks IntroDB (introdb.app): a community database of skip times by IMDb id, season and episode (`GET /segments`, no key, rate-limited, commercial use allowed "with reasonable usage"). Its `intro`, `recap` and `outro` (end credits) are used. `post_credits` is a scene to watch, so it isn't skipped. IntroDB only answers browsers from its own site (CORS), so `internal/markers` asks it from Go, with a 10 s cap. IntroDB takes IMDb ids only, and catalogs may name a title otherwise: TMDB addons give series ids like `tmdb:1396`, while the episode's video id, which stream addons are asked with, is still `tt0903747:2:3`. So an episode's IMDb id and numbers come from its video id first, then from the content id with the episode's season and number. A film's IMDb id comes from its content id or video id. Titles with no IMDb id anywhere (Kitsu's anime) ask nothing: AniSkip (MAL ids) would cover them, and is a follow-up. The ticket's "addon meta" isn't a source: the Stremio protocol has no field for skip times.

**IntroDB's times are for one release, so they're checked against the file.** A segment ends at the end of the file at most, and one starting past the end is dropped (another cut). An intro or recap starting after the credits is dropped too: IntroDB has one for a film (tt0371746) after its credits. Segments under 3 s aren't offered. The chapters always win, since they belong to the file.

**A button, and auto-skip for intros and recaps.** While the position is in a segment (but not its last second), "Skip intro", "Skip recap" or "Skip credits" shows above the controls, on the right, and seeks to the segment's end. Skipping credits that run to the end ends the file, which plays the next episode when its card is up, as the end does. With a next episode coming, the card stands in for Skip credits. Settings › Playback › "Skip intros automatically" (the profile's `skipIntros`, off by default) skips intros and recaps by themselves, once per segment per file, with a "Skipped the intro" notice. Seeking back into one shows the button instead. Credits are never skipped automatically: the card and the end handle them, and some films' credits are worth watching. There's no key for it. Tab reaches the button, and a focused button would take Space from play and pause.

**Asking IntroDB is the device's choice.** Asking tells IntroDB what's playing, so "Look up intro and credits times" (`DeviceSettings.skipTimesOnline`, on by default) turns it off. Go checks it too (`markers.UseSettings`), so nothing is asked when it's off.

**Checked:** Go tests for `internal/markers` (recorded answers, other ids, the setting, 429 and 5xx) and the chapter list. Frontend tests for the chapter names, the checks against the file, `countdownFrom`'s credits rule and the player screen (chapters, IntroDB for an episode and a film, the setting off, auto-skip once). A live lookup from Go answered for Breaking Bad S2E3 (intro 3:36–3:52, credits from 46:10) and the film above. In the app on macOS (a build with a temporary play hook, a copy of the real store, generated clips): IntroDB's intro showed Skip intro at 3:36, on top of the video, for a `tmdb:1396` series with an IMDb video id. A file with an Opening chapter and auto-skip on jumped from 1:00 to 2:31 with "Skipped the intro". The first live check missed the TMDB ids: every series the profile had played was `tmdb:`, so nothing was ever asked. **Not checked:** the tests haven't been run yet, a click on the button (no synthetic input while the Mac is in use), the credits and next-episode path in the app, and Windows.

## Hardware decoding and HDR (#66)

**Hardware decoding follows Settings › Playback, per session.** `player.UseSettings` gives the service the store, and each session reads `DeviceSettings.hardwareDecoding` as it opens (on by default, and on if the store can't be read). On, `hwdec` is the OS's own decoder API first, then whatever else mpv deems safe: `videotoolbox,auto-safe` on macOS, `d3d11va,auto-safe` on Windows (every GPU driver has D3D11VA), `vaapi,auto-safe` on Linux (Intel and AMD; NVIDIA gets NVDEC through `auto-safe`). Off, it's `no`. mpv decodes in software what the GPU can't, and falls back to software when a hardware decoder fails on a file (`hwdec-software-fallback`, 3 frames), so a failure never stops playback. The setting takes effect from the next video: leaving the player closes the session. `$PELI_MPV_OPTIONS` still overrides it. `State.hwdec` says what is decoding (`""` for software).

**HDR goes to the display as HDR where the OS and the display can show it, and is tone-mapped by mpv everywhere else.** What mpv does by default (`target-trc=auto`, `tone-mapping=auto`, `hdr-compute-peak=auto`) is the tone-mapping: an HDR video on an SDR target is mapped to it. Passthrough differs per OS:

| OS | Passthrough | How |
|---|---|---|
| macOS | When the window's screen can show EDR as the session opens (an XDR display, or HDR on for it in System Settings: `maximumPotentialExtendedDynamicRangeColorComponentValue > 1`) | The layer gets a half-float back buffer (`kCGLPFAColorFloat`, `RGBA16Float`, `internal_format=GL_RGBA16F`, depth 16), like mpv's `cocoa-cb`. When `video-params/gamma` is `pq` or `hlg`, Go sets `target-trc=pq`, `target-prim=bt.2020`, and the host tags the layer BT.2100 PQ with `wantsExtendedDynamicRangeContent`: macOS maps it to the headroom the display has. An SDR video goes back to `auto` and the screen's colourspace. `State.hdr` is true while it's on |
| Windows | When Windows' HDR is on for the display | mpv's own window (`vo=gpu-next`) with `target-colorspace-hint=auto` switches its swap chain to HDR10 for an HDR video |
| Linux | Never | GTK shows our GL textures as SDR. GTK 4.16+ has colour states for dmabuf textures, which a later host could use |

An SDR video on the half-float layer is tagged with the screen's colourspace: untagged, Core Animation reads half-float as linear and SDR looks washed out. Tagged, the colour bars of a test clip matched the 8-bit layer's within 1/255.

The screen is checked when the session opens, because the pixel format can't change afterwards. Moving the window from an SDR to an EDR screen mid-video gives tone-mapped SDR until the next video. The other way round, macOS maps the PQ layer down itself.

**Checked:** Go tests (`decoding_test.go`, with `testdata/hdr10.mp4`, 1 s of HEVC Main10 BT.2020/PQ with HDR10 metadata) cover the setting (on, off, unreadable), the PQ target and the host's switch on a host that can show HDR, and plain `auto` on one that can't. In the app on macOS, with the setting on, 8-bit H.264 and 10-bit HEVC HDR10 decode with `videotoolbox` (zero-copy), and with it off in software. The test display has no EDR headroom, so the EDR path was forced for one run: the HDR10 clip switched the layer to PQ and `State.hdr` to true, and macOS mapped it to SDR. **Not checked:** HDR on an EDR screen by eye (needs an XDR or HDR display, as M0 found), D3D11VA and Windows HDR10 (no Windows GPU), VA-API (no Linux GPU; #91). The render API is OpenGL only, so mpv's `gpu-next` HDR path (libplacebo, Dolby Vision profile 5 reshaping, `CAEDRMetadata`) isn't available on macOS or Linux; Dolby Vision without an HDR10 base layer may show wrong colours there. Our own libmpv (#92) must keep VideoToolbox, D3D11VA, VA-API and NVDEC.

## Keys and media controls (#67)

**The keys are the screen's, in React.** The webview gets every key (mpv has no input, ADR-0002), and one window listener in `player-page.tsx` maps them:

| Key | Does |
|---|---|
| Space, K | Play or pause |
| ← → | Back or forward 10 s, as the buttons |
| ↑ ↓ | Volume ±5; ↑ unmutes, at the volume it had |
| M, F | Mute, full screen |
| I | The mini player and back (#70) |
| Esc | Closes the shortcuts, then leaves the mini player or full screen, then the screen |
| A | Next audio track (two or more) |
| C | Next subtitle track, then off (the file's and the addon ones added) |
| Z, X | Subtitles 0.1 s earlier or later (#62, kept where they were) |
| S | The stream switcher (#68) |
| ? | The shortcuts over the video, also from a keyboard button in the controls |

Space, F, M, Z and X are mpv's keys, K and C YouTube's, so the keys most people try first work. Arrows, volume and Z/X repeat when held; the rest act once a press. A focused slider keeps its own arrows (Base UI prevents the default, and the listener skips those). While a menu or the error overlay is open the keys are theirs, and keys with ⌘, Ctrl or Alt are left to the app (⌘F, ⌘1–4). The changes a key makes show for a moment over the video ("Volume 45 %", "Subtitles: English · SDH", "Audio: Japanese · AC3 · 5.1"). Track switching by key goes through the same pick as the menus, so a picked subtitle's language becomes the profile's (#63). The buttons carry `aria-keyshortcuts`. The overlay doesn't take focus or the keys.

**The OS's media controls are Go's, so they work with the window hidden.** `Service.SetNowPlaying({title, subtitle})` names what plays (the screen sends its heading); Stop forgets it. The event loop hands the media controls the title, paused, position, duration, speed and a count of jumps, whenever the state changes (not on time events: each OS moves the position on by the speed itself), on a goroutine of their own that skips states it was too slow for. Their commands run like the screen's own (`SetPaused`, `cycle pause`, `SeekBy`, `Seek`), and the screen follows through `player:state`. An episode is named as the OS names a song: the episode as the title, the series as the artist.

| OS | How | Commands |
|---|---|---|
| macOS | `MPNowPlayingInfoCenter` (`playbackState` set by hand, as macOS needs) and `MPRemoteCommandCenter`, from the first state to Stop; Stop removes the targets and clears Now Playing, so the media keys go back to other apps | Play, pause, toggle (the play/pause key, AirPods), skip ±10 s, the Control Center scrubber |
| Linux | MPRIS on the session bus (godbus, our own `Properties` so `Position` is read live), `org.mpris.MediaPlayer2.peli` (`.instance<pid>` when taken) from the first state to Stop | Play, Pause, PlayPause, Stop (pauses: leaving is the screen's), Seek, SetPosition for the track playing; `Seeked` on jumps |
| Windows | libmpv's own System Media Transport Controls (`media-controls=yes`, off by default for libmpv; mpv ≥ 0.39 built with `win32-smtc`) on a hidden window of mpv's. It names what plays by `media-title`, so `SetNowPlaying` also sets `force-media-title` | Play, pause, the timeline, and chapters for next/previous. Its Stop button stops mpv's file, which the screen sees as an idle session; Esc or Back still leaves |

Next and previous track are off on macOS and Linux: a film has no tracks, and the next episode is the card's to offer (#65). No artwork yet. Windows may show "Unknown app" until Peli is installed with an AppUserModelID.

**Checked:** Go tests drive the service's media state and commands with a fake (title, pause, toggle, jumps, Stop), and on Linux a test of its own bus checks MPRIS: properties, every method, the signals and the instance name (Docker, `dbus-daemon`). Route tests cover every key. In the app on macOS, the play/pause media key paused and resumed a playing clip with the window in the background, and the Music app stayed closed. **Not checked:** Windows (cross-compiled and vetted, no Windows machine), a real Linux desktop widget (#91).

## The window while playing

A session makes the window fill its screen, **not fullscreen**: what a double click on the title bar does, not the green button. On macOS the window takes the screen's visible frame (all but the menu bar and Dock), which macOS then counts as zoomed; on Windows it's Wails' `Maximise`. A window that's fullscreen or fills the screen already is left as it is. `Stop` puts it back at its size and place before playback, from the mini player too, in one move (`peli_window_restore`, `restoreWindow` in `mini_other.go`). A window still fullscreen at `Stop` stays fullscreen, and leaving fullscreen later brings back the filled size. Next episodes keep the session, so the window doesn't move between them.

**Checked:** in the app on macOS with a temporary play hook, a 1100×700 window filled the 3840×1477 work area on Load, and went back to 1100×700 at the same place on Stop, and on Stop from the mini player. **Not checked:** Windows.

## Mini player (#70)

F25's picture-in-picture is **the app window made small**, not a second window or the OS's PiP. The video is drawn under the webview in the app window (ADR-0002), so moving it to another window would mean a second host and render context per OS. macOS's own PiP (`AVPictureInPictureController`) only takes an `AVPlayerLayer` or sample buffers, so every mpv frame would have to be copied out of OpenGL into `CVPixelBuffer`s. Windows has no system PiP at all. A small window works the same way on both OSes, and it keeps the session, the controls and the keys as they are. The cost is that the app can't be browsed while the mini player shows, which is fine for watching while working in other apps.

`Service.SetMini(on)` needs a session; `Stop` leaves the mini player, so leaving the screen any way (Back, the end, quitting) puts the window back. A fullscreen window leaves fullscreen first (it waits up to 3 s for the window event, as macOS animates it), and `SetFullscreen(true)` leaves the mini player first. `State.mini` tells the screen.

| OS | The mini player |
|---|---|
| macOS (`mini_darwin.m`) | 480 pt wide (a third of the screen at most), in the video's shape (`video-out-params/aspect`, 16:9 before the first frame), at the bottom right of the screen's visible frame, 16 pt in. `NSFloatingWindowLevel`, on every Space and over full-screen apps (`CanJoinAllSpaces`, `FullScreenAuxiliary`). The traffic lights are hidden (close would quit). A resize keeps the shape (`contentAspectRatio`). Leaving restores the frame, level and Spaces behaviour |
| Windows (`mini_other.go`) | The same size and corner of the screen's work area, with Wails' `SetBounds` and `SetAlwaysOnTop`. No aspect lock: Wails has none |
| Linux | The Windows code compiles for it; deferred with Linux (#103) |

Both remember where the user left the mini player during the run, and open there again while it's still on that screen.

**The screen in the mini player** shows play/pause, mute and volume, the time, the seek bar, Back and Exit mini player. Menus, ±10 s, Streams, the shortcuts and Full screen are hidden, and so is "Start over". The skip button shows, and so does a smaller next-episode card without the thumbnail. A double click or Esc goes back to the app window. Streams (S, or "Choose another stream" when a file fails) leaves the mini player first, and `?` does nothing.

**Checked:** in the app on macOS, with a temporary play hook (not committed) and a 2.4:1 clip, the mini player opened at 480×200 in the bottom right corner of a 3840-wide display at window layer 3 (floating). It opened from fullscreen too, and the window went back to 999×617 at layer 0 when leaving and on Stop. Route tests cover the button, I, Esc and the hidden controls. **Not checked:** screenshots (no screen-recording permission in that session), resizing by hand, Spaces and full-screen apps, Windows.

## The hosts, as run

- **macOS** (M1 Pro, macOS 27, Homebrew libmpv 0.41): video under the webview, letterboxed, with the React page on top. Resize, fullscreen on the external display and back, pause, stop and 20 reloads all fine. The layer never draws on the main thread: `needsDisplayOnBoundsChange` is off, and a resize or a backing-scale change (another display) asks our queue to draw. If Core Animation asks on the main thread anyway, it gets black and a redraw from the queue. While playing, an `NSProcessInfo` activity keeps App Nap and display sleep away. `drawsBackground` is turned off on the `WKWebView` by hand (Wails beta.28 leaves it on) and restored on `Stop`.
- **Linux** (Debian 13 container, GTK 4.18, libmpv 0.40, llvmpipe: no GPU): video under the webview on X11 (Xvfb + openbox + picom) and Wayland (headless sway), resize fine, `Stop` takes the thread count back each time. The picture is made once and hidden between sessions, and the webview's background is made transparent and restored in C. A slot release that arrives late, from GTK's previous session, carries an old generation and is ignored, or it would free a texture GTK is showing. **Not settled:** at 1080p60 in software, some frames showed llvmpipe's tile grid (a texture sampled mid-render), on X11 from the second session and once on Wayland. One Wayland run showed a black video plane under working subtitles. At 720p30 all were clean. That points at CPU starvation in the container more than at the host, but #91 must check it on a real GPU desktop, together with the X11 host choice.
- **Windows**: compiled (mingw-w64 cross-build, `go vet`) but **not run**: no Windows machine, and GitHub Actions was down. The host follows #2/#3: `vo=gpu-next` pinned, `wid` set to the window's HWND, and on every `vo-configured` (mpv recreates its window on a VO re-init) its window goes to `HWND_BOTTOM` and is disabled. The webview is made transparent through Wails' `SetBackgroundColour` (WebView2 takes alpha 0 or 255 only), and the frontend repaints the theme colour when the player closes, since Wails has no getter for it.

## Consequences

- Every build links libmpv. Until #92's pinned LGPL builds exist, CI links the distro's (Linux), Homebrew's (macOS) and shinchiro's (Windows, the spikes' build), and nothing bundles it. Windows builds with cgo now (`CGO_ENABLED` defaults to 1 in its Taskfile).
- Keeping the screen awake on Linux and Windows isn't done: their `playing` hooks are empty.
- A watched mark held at exit is in the outbox after the next launch, but the grace lives in memory: if the launch push runs before the launch pull, it goes out and repeats the server's item. That needs quitting within 75 s of crossing 90 %, which for a film or an episode lands in the credits or before them.
- The controls are #61's: seek bar (buffered range, hover time, scrub while dragging, exact seek on release), play/pause, ±10 s, volume, fullscreen, title and episode, auto-hide with the cursor, buffering and error overlays. What the user sets shows at once and waits for the state to catch up (`useAhead`, 3 s at most); seeks and volume changes go one at a time, newest next (`latestOnly`).
