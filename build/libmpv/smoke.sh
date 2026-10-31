#!/usr/bin/env bash
# #92: builds and runs the smoke test against a built libmpv directory.
#
#   build/libmpv/smoke.sh <libmpv-dir>
#
# It plays the player's own fixtures (internal/player/testdata): H.264 in MP4
# with AAC, HEVC 10-bit HDR10, Matroska with SubRip subtitles, and HLS.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
dir=$(cd "${1:?usage: smoke.sh <libmpv-dir>}" && pwd)
testdata=$here/../../internal/player/testdata
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

arch=$(lipo -archs "$dir/lib/libmpv.2.dylib")
clang -arch "$arch" -mmacosx-version-min=12.0 -Wall -Wno-deprecated-declarations \
	-I"$dir/include" "$here/smoke/smoke_darwin.c" -L"$dir/lib" -lmpv -Wl,-rpath,"$dir/lib" \
	-framework OpenGL -o "$out/smoke"

"$out/smoke" "$testdata/clip.mp4" "$testdata/hdr10.mp4" "$testdata/tracks.mkv" "$testdata/hls/index.m3u8"
