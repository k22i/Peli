#!/usr/bin/env bash
# Test fixtures for the spike, made with Homebrew ffmpeg (libx264, libx265,
# libsvtav1, libopus) and a hand-written PGS stream. 30 s each, a test pattern
# with a running clock, so a screenshot shows where playback is.
#   media/hevc10-eac3-ass.mkv   HEVC Main10 1080p, E-AC-3 + AC-3, two ASS tracks (styled)
#   media/h264-dts-srt.mkv      H.264 1080p, DTS, two SRT tracks
#   media/h264-pgs.mkv          H.264 720p, AAC, PGS bitmap subs
#   media/av1.mkv               AV1 720p, Opus
#   media/h264-aac.mp4          H.264 1080p, AAC (what AVPlayer plays)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p media && cd media
D=30
v() { echo -f lavfi -i "testsrc2=size=$1:rate=24:duration=$D"; }
a() { echo -f lavfi -i "sine=frequency=$1:duration=$D"; }

cat > en.srt <<'S'
1
00:00:01,000 --> 00:00:05,000
SRT english cue one
second line, <i>italic</i>

2
00:00:08,000 --> 00:00:14,000
SRT english cue two at 8 s

3
00:00:16,000 --> 00:00:24,000
SRT english cue three at 16 s
S
sed 's/english/espanol/' en.srt > es.srt

cat > en.ass <<'S'
[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Helvetica,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,40,40,60,1
Style: Fancy,Georgia,80,&H0000D7FF,&H000000FF,&H00802000,&H00000000,-1,-1,0,0,100,100,2,0,1,4,3,8,40,40,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:06.00,Default,,0,0,0,,ASS default style, {\i1}italic{\i0} and {\b1}bold{\b0}
Dialogue: 0,0:00:03.00,0:00:10.00,Fancy,,0,0,0,,{\fad(500,500)}ASS fancy: gold, outline, top
Dialogue: 1,0:00:08.00,0:00:16.00,Default,,0,0,0,,{\an5\pos(960,540)\frz-8\fs96\1c&H00FF00&\bord6}ASS positioned + rotated
Dialogue: 0,0:00:14.00,0:00:24.00,Default,,0,0,0,,{\k50}Karaoke {\k50}timing {\k50}works {\k50}here
S
sed 's/ASS /ASSes /' en.ass > es.ass

python3 ../scripts/mkpgs.py pgs.sup 28 1280 720

# shellcheck disable=SC2046
ffmpeg -y -v error $(v 1920x1080) $(a 440) $(a 880) -i en.ass -i es.ass \
	-map 0:v -map 1:a -map 2:a -map 3 -map 4 \
	-c:v libx265 -preset veryfast -crf 28 -pix_fmt yuv420p10le -c:a:0 eac3 -b:a:0 192k -c:a:1 ac3 -b:a:1 128k -c:s copy \
	-metadata:s:a:0 language=eng -metadata:s:a:1 language=spa -metadata:s:s:0 language=eng -metadata:s:s:1 language=spa \
	hevc10-eac3-ass.mkv

ffmpeg -y -v error $(v 1920x1080) $(a 440) -i en.srt -i es.srt \
	-map 0:v -map 1:a -map 2 -map 3 \
	-c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -c:a dca -strict -2 -b:a 384k -ar 48000 -c:s srt \
	-metadata:s:a:0 language=eng -metadata:s:s:0 language=eng -metadata:s:s:1 language=spa \
	h264-dts-srt.mkv

ffmpeg -y -v error $(v 1280x720) $(a 440) -i pgs.sup \
	-map 0:v -map 1:a -map 2 \
	-c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -c:a aac -b:a 128k -c:s copy \
	-metadata:s:a:0 language=eng -metadata:s:s:0 language=eng \
	h264-pgs.mkv

ffmpeg -y -v error $(v 1280x720) $(a 440) \
	-map 0:v -map 1:a -c:v libsvtav1 -preset 8 -crf 35 -pix_fmt yuv420p10le -c:a libopus -b:a 96k \
	av1.mkv

ffmpeg -y -v error $(v 1920x1080) $(a 440) \
	-map 0:v -map 1:a -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart \
	h264-aac.mp4
ls -l *.mkv *.mp4
