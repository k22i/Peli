#!/usr/bin/env bash
# Generates the test media (needs ffmpeg with libx264 and libx265):
#   media/test.mp4        60s 720p30 test pattern with a burnt-in clock, two
#                         audio tracks and one subtitle track (as in #3)
#   media/bench-1080p60.mp4  20s 1080p60, for the CPU/GPU and pacing bench
#   media/hdr10.mp4       10s 2160p24 10-bit HEVC tagged BT.2020 / PQ (HDR10),
#                         with highlights well above SDR white, for the EDR check
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p media
srt=$(mktemp)
for i in $(seq 0 5 55); do
  printf '%d\n00:00:%02d,000 --> 00:00:%02d,000\nSubtitle cue at %ds\n\n' $((i/5+1)) "$i" $((i+4)) "$i" >> "$srt"
done
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=60" \
  -f lavfi -i "sine=frequency=440:duration=60" \
  -f lavfi -i "sine=frequency=660:duration=60" \
  -f srt -i "$srt" \
  -map 0:v -map 1:a -map 2:a -map 3:s \
  -c:v libx264 -preset veryfast -crf 32 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -c:s mov_text \
  -metadata:s:a:0 title="440 Hz" -metadata:s:a:1 title="660 Hz" -metadata:s:s:0 language=eng \
  -movflags +faststart media/test.mp4
rm -f "$srt"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=20" \
  -f lavfi -i "sine=frequency=440:duration=20" \
  -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -c:a aac -b:a 64k \
  -movflags +faststart media/bench-1080p60.mp4

# The pattern's code values are taken as PQ: its whites become ~10000-nit
# highlights, its mid greys land around SDR white. Mastering metadata says
# 1000 nits, like typical HDR10 releases.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=3840x2160:rate=24:duration=10" \
  -vf "format=yuv420p10le" \
  -c:v libx265 -preset ultrafast -crf 28 -tag:v hvc1 \
  -x265-params "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400" \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -movflags +faststart media/hdr10.mp4
ls -lh media/
