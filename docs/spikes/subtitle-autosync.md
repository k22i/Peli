# Spike: subtitle AutoSync

Date: 2026-11-23 · Spike code: [`spikes/subtitle-autosync/`](../../spikes/subtitle-autosync/) (throwaway). Results: [`spikes/subtitle-autosync/results/`](../../spikes/subtitle-autosync/results/).

Reference: Nuvio's AutoSync ([blog post](https://nuviosync.com/blog/nuvio-subtitle-autosync), NuvioTV [#3605](https://github.com/NuvioMedia/NuvioTV/issues/3605) design, [#3828](https://github.com/NuvioMedia/NuvioTV/issues/3828) / [#4133](https://github.com/NuvioMedia/NuvioTV/issues/4133) run policy, [#3835](https://github.com/NuvioMedia/NuvioTV/issues/3835) no toasts over subtitles, [#4716](https://github.com/NuvioMedia/NuvioTV/issues/4716) external reference, PR [#4150](https://github.com/NuvioMedia/NuvioTV/pull/4150) audio fallback, NuvioMobile [#2535](https://github.com/NuvioMedia/NuvioMobile/pull/2535) shared mpv engine).

## Verdict

**Go, for the embedded-subtitle reference.** Build it like Nuvio's mpv path: read the stream's own subtitle timing from the Matroska `Cues` index with a few range requests, align the addon subtitle's cue times to it (no text, no audio), and give mpv a retimed copy when the fit is confident. **Not now: the audio fallback** (VAD/ASR, a 74 MB model on Nuvio). It's the only way to cover the quarter of releases with no reference, but it's a separate, much larger piece of work.

- **Addon subtitles are often out of sync.** Of 137 English OpenSubtitles files measured against the release they played on, 89 (65 %) were off by more than 0.3 s, and 65 by more than 10 s. OpenSubtitles v3 ignores the `filename` and `videoSize` extras Peli sends, so every release of a title gets the same list.
- **Most releases carry a reference.** 51 of 69 (74 %) had a full subtitle track with its packets in `Cues` (text or PGS, mkvmerge indexes every subtitle frame). The rest: no subtitle tracks (5), forced tracks only (5), subtitles left out of `Cues` by older muxers (6), MP4 (2, Nuvio indexes those from `moov`; not done here), a short signs track (1).
- **It's cheap.** Reading the index took 3 requests, 0.5–3.5 MB and 0.4–3.4 s per release over TorBox's CDN. Aligning took 0.46 s median against up to four reference tracks on an M1 Pro (unoptimised).
- **It's safe at the chosen gate (score ≥ 0.4, margin ≥ 0.05).** 58 of the 89 out-of-sync files were fixed (every truth point within 0.3 s), **no in-sync file was moved**, 4 were moved closer but not within 0.3 s (cuts), and 27 were left alone (no confident fit: mostly files whose offset changes along the film).
- **Piecewise (split) correction isn't worth it yet.** It added 0–2 fixes over the global model (offset plus frame-rate ratio), which already covers 25 vs 23.976 fps and 1.001 drift.

## How this was tested

- **Corpus:** 70 releases of 27 titles already in the user's TorBox account (read-only: links from `requestdl`, no torrent added), chosen so several releases share a title: 14 Dune (2021), 6 Thunderbolts*, 6 Slow Horses S01E01, 5 Interstellar, and others ([`corpus.json`](../../spikes/subtitle-autosync/results/corpus.json)). Candidates: up to six English, Spanish and French files per title from OpenSubtitles v3.
- **Ground truth, independent of the aligner:** for releases with a full English text track, the spike read the words of 3 × 12 embedded lines (at 15 %, 50 % and 85 % of the track) from the packets the `Cues` point to, matched them to the candidate's lines by words, and took the median offset per window. Only pairs with two or more windows count (137). The aligner never sees text.
- **Aligner:** a Hough vote over offsets (±5 min, 100 ms bins) for each frame-rate ratio, a fine search, least squares on matched pairs, and a margin against the best rival transform at least 1 s away. Synthetic tests cover offsets, 25 fps, 1.001 drift, a 4-minute recap, splits and an unrelated file.

## What Peli builds from this

- Go `internal/subsync`, shared by desktop and iOS: the `Cues` loader (HTTP with the stream's headers and user agent, or a downloaded file), the aligner with the gate above, and the retimer (SRT, WebVTT, ASS: times only).
- The reference is loaded when a file loads, once per file, and a failed load isn't retried (Nuvio #3828, #4133). `AddSubtitle` waits a few seconds at most for it, aligns, and adds the retimed copy. Without a reference or a confident fit, the original is added unchanged.
- A profile setting, on by default (as on NuvioTV 1.1.0). The result shows in the subtitle panel (a Synced badge, and the shift with "Use original timing" in Timing), never as a toast over the subtitles (Nuvio #3835).
- Later: MP4 `moov` indexing, the file's own subtitles as a live reference when `Cues` lack them, picking the best-fitting addon file among same-language candidates (Nuvio's startup search), and the audio fallback.
