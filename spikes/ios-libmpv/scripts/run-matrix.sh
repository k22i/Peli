#!/usr/bin/env bash
# The coverage matrix: every fixture on one simulator device.
#   scripts/run-matrix.sh <device-udid> <prefix>
set -euo pipefail
cd "$(dirname "$0")/.."
dev=$1 pre=$2
B="scale=bilinear;cscale=bilinear;dscale=bilinear;dither=no;correct-downscaling=no;sigmoid-upscaling=no;sub-pos=60"
S="wait:3,snap:a,ui:seekfwd,wait:2.5,snap:b,ui:audio,wait:1,ui:sub,wait:2,snap:c,ui:pause,wait:1,snap:paused,ui:pause,wait:2,snap:d"
P="wait:2,ui:sub,wait:2.6,snap:a,ui:seekfwd,wait:2.5,snap:b,ui:audio,wait:1,snap:c,ui:pause,wait:1,snap:paused,ui:pause,wait:2,snap:d"
U=http://127.0.0.1:8765
scripts/run-case.sh "$dev" "$pre-hevc10-eac3-ass" $U/hevc10-eac3-ass.mkv "$S" videotoolbox-copy "$B" ""
scripts/run-case.sh "$dev" "$pre-h264-dts-srt" $U/h264-dts-srt.mkv "$S" "" "$B" ""
scripts/run-case.sh "$dev" "$pre-h264-pgs" $U/h264-pgs.mkv "$P" "" "$B" ""
scripts/run-case.sh "$dev" "$pre-av1" $U/av1.mkv "$S" "" "$B" ""
scripts/run-case.sh "$dev" "$pre-h264-aac" $U/h264-aac.mp4 "$S" "" "$B" ""
