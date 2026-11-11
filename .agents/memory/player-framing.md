---
name: player-framing
description: "Player enhancements phase 2 (2026-11-11): store.Framing (fit, aspect, zoom/pan, crop %, auto-crop, rotate, flips), crop → pixels from video-params, Go auto-crop via screenshot-raw (no cropdetect), sheet tabs, Shift+F/Shift+A/= − 0/⌥+arrows, drag to pan"
metadata:
  type: project
---

Phase 2 of the player enhancements ([[player-picture]] has the model and plan).

- **Model:** `store.Framing` (fit `fit|fill|stretch|original`, aspect `auto` / preset / `W:H`, zoom log2 −2–2, panX/Y −1–1, `Crop` edges in percent ≤ 40, autoCrop, rotate 0/90/180/270, flipH/V) is a `TitleAdjustments.framing` section. The profile's `ProfileSettings.framing` only contributes **fit and autoCrop** (`framingFor` in Go, `framingOf` in `lib/framing.ts` agree); "Use for all titles" on the Framing tab saves just those.
- **mpv:** fill = `panscan=1`, stretch = `keepaspect=no`, original = `video-unscaled=downscale-big`, `video-aspect-override` (`-1` = file's), `video-zoom`, `video-pan-x/y`, `video-rotate` — all renderer-side. Flips are `vf=@sinag-hflip:lavfi=[hflip],…`; with them mpv used no hardware decoder on the test clip (plain yuv420p frames), hence the sheet's power hint. Every Load sets all of them and clears `video-crop`.
- **Crop:** `video-crop`'s `+x%` offsets are window-geometry semantics (share of the leftover space), so Go converts percent → even pixels (`cropProp`) from `video-params/w,h`, now observed; `applyCrop` runs when they arrive and on `SetFraming`.
- **Auto-crop (`autocrop.go`):** FFmpeg's `cropdetect` is GPL. `findBars` takes `screenshot-raw video bgr0` frames (new `mpv.commandResult` + byte arrays in `nodeToGo`) at 1–120 s, `detectBars` counts edge rows/cols ≥ 98.5 % pixels ≤ 26, ignores frames with < 30 % left, needs 3 frames, applies `leastBars` (never cuts picture), refines as it goes; `State.autoCrop` reports it (cleared each Load). One goroutine per file, cancelled by Load/Stop/SetFraming without auto.
- **Frontend:** sheet is a tab shell (`picture-sheet.tsx`: Picture, Framing; `framing-tab.tsx`), shared bits in `panel-controls.tsx` (`sheetSurface`, `Preview`/`previewRow` for the drag preview, `SectionHead`, `ChipGroup`, `Chip`) — keep them there, a tab importing the sheet makes an import cycle the linter refuses.
- **Keys:** W is the watch party's (#party), so fit is **Shift+F**, aspect **Shift+A** (a `shifted` map checked before lowercasing), `=`/`+`/`−` zoom (repeat), `0` back to 1×, **⌥+arrows** pan by `event.code` (Option changes `event.key`; the handler no longer drops altKey outright). A drag on the video surface while zoomed pans (`panDrag`, a drag suppresses the click); cursor `grab`.
- Settings › Playback › Framing: default fit, Remove black bars. "Titles you adjusted" counts picture or framing.
- Related: [[player-picture]], [[player-keys-media]], [[watch-party]], [[libmpv-build]].
