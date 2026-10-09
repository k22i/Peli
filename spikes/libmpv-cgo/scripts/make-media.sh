#!/usr/bin/env bash
# Generates media/test.mp4: 60s 720p test pattern with a burnt-in clock, two
# audio tracks and one subtitle track, so track-list switching has something
# to switch between.
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
ls -lh media/test.mp4
