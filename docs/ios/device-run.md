# iOS device runs

Results of the on-device checklist in [`ios/README.md`](../../ios/README.md#first-on-device-checklist). Peli is installed through SideStore on a free Apple ID; the build is production unless noted. CPU is the `iosplayer: stats` figure: the whole process, in percent of one core.

## Devices

| Device | Model | iOS | Peli build | SideStore |
|---|---|---|---|---|
| iPhone | | | | |
| iPad | | | | |

## Results

| # | Check | iPhone | iPad | Notes |
|---|---|---|---|---|
| 1 | Installs and opens | | | |
| 2 | Zero-copy, 1080p HEVC 10-bit | | | |
| 3 | 1080p H.264 and 4K HEVC | | | |
| 4 | 10-bit to 8-bit CPU cost (AV1, Hi10p) | | | |
| 5 | Fallbacks (copy, software, Settings off) | | | |
| 6 | No GL drawing in the background | | | |
| 7 | System interruptions | | | |
| 8 | Plays with LocalDevVPN on | | | |
| 9 | Keychain after a reboot | | | |
| 10 | Keychain and data across a refresh and a reinstall | | | |
| 11 | iPad layouts | n/a | | |
| 12 | iPad split view and windows | n/a | | |
| 13 | On-screen keyboard | | | Not run yet. #137 built the keyboard handling (`--keyboard-h`, scroll-to-dismiss, instant Search focus, TMDB sheet) but no device has run it. Steps in the check 13 row of `ios/README.md`. Screenshots: `epic126-137-*.png` |
| 14 | Background refresh | | | |

## Playback numbers

| Device | Stream (codec, size, bit depth) | Mode | container fps | vf fps | Drops (decoder / output / delayed) | CPU % |
|---|---|---|---|---|---|---|

## TorBox entries added

Streams resolved during the run, to delete afterwards.
