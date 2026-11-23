---
status: accepted
date: 2026-11-24
---

# Subtitle AutoSync: addon subtitles are lined up with the video's own subtitle timing, read from its Matroska index, before mpv gets them

Nuvio added AutoSync (NuvioTV 1.1.0, on by default; NuvioMobile and Desktop share its engine). The spike ([`docs/spikes/subtitle-autosync.md`](../spikes/subtitle-autosync.md)) measured 70 releases: 65 % of OpenSubtitles files were out of sync with the release they played on, 74 % of releases carry a usable reference, and a text-free aligner fixed 58 of 89 out-of-sync files without moving an in-sync one.

## Decisions

1. **Reference: the file's own subtitle timing, from Matroska `Cues`.** `internal/subsync` reads the EBML header, SeekHead, Info, Tracks and Cues with range requests (the stream's headers and user agent, as mpv sends; a download's file from the disk). No clusters, no audio, no text. MP4 and files whose Cues leave subtitles out have no reference.
2. **Read once per file, in the background.** `Load` starts it (`playback.StartSync`); the next `Load` or `Stop` cancels it. A failed read isn't retried for that file (Nuvio #3828, #4133).
3. **Applied in Go, before `sub-add`.** `AddSubtitle` with `Subtitle.autoSync` waits up to `SyncWait` (6 s) for the reference, aligns, and writes a retimed copy (times only; SubRip, WebVTT, ASS). Without a reference, in time or at all, or without a confident fit, the addon's file is added as it was. The user's subtitle delay (Timing, Z/X) adds to the result.
4. **Model and gate.** t' = scale·t + offset, the scale from the usual frame-rate ratios plus least squares; applied when the fit matches ≥ 40 % of the lines and beats the best rival by ≥ 0.05, and leaves the file alone when it moves nothing more than 300 ms. No piecewise (cut) correction: it added nothing measurable.
5. **Setting and feedback.** `ProfileSettings.autoSyncSubtitles`, on by default (older profiles read it as on), in Settings › Languages & subtitles. `Player.SubtitleSync(id)` reports `synced`, `inSync`, `noMatch`, `noReference` or `unchecked`, shown as a Synced badge on the addon row and a note in Timing with "Use original timing", which adds the file again unsynced. No toast over the subtitles (Nuvio #3835).

## Not now (revisit triggers)

- MP4 `moov` sample tables as a reference (Nuvio has them; 2 of the spike's 70).
- The file's own subtitles seen while playing, for files whose Cues lack them.
- Choosing the best-fitting addon file among same-language candidates (Nuvio's startup search).
- Audio sync (VAD/ASR, Nuvio PR #4150) for files with no reference: a model download and a decoder tap; its own spike.
- Another addon file as the reference (Nuvio #4716).
