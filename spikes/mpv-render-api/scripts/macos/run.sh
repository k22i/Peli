#!/usr/bin/env bash
# Runs the spike self-test on this Mac and saves results/<name>.json, .log,
# .png (and -fullscreen.png). Needs Screen Recording permission for the
# terminal, or the screenshots show only the wallpaper.
#
#   scripts/macos/run.sh gl                       # CAOpenGLLayer under the WKWebView
#   scripts/macos/run.sh sw                       # software render API
#   SPIKE_HDR=pq scripts/macos/run.sh gl gl-hdr-pq   # plus the HDR10 / EDR check
set -euo pipefail
mode=${1:-gl}
name="macos-${2:-$mode}"
cd "$(dirname "$0")/../.."
out="$PWD/results"
mkdir -p "$out" bin
[ -x bin/spike ] || go build -o bin/spike .

export SPIKE_MODE="$mode" SPIKE_SELFTEST="$out/$name.json" SPIKE_HOLD=4 SPIKE_EXIT=1 SPIKE_INPUT_WAIT=2
export SPIKE_WINDOW_X=100 SPIKE_WINDOW_Y=100 SPIKE_MEDIA="$PWD/media/test.mp4" SPIKE_MPV_LOG="$out/$name.mpv.log"
export SPIKE_HIDDEN_STEP=1 SPIKE_FULLSCREEN_HOLD=2 SPIKE_BENCH_MEDIA="${SPIKE_BENCH_MEDIA:-$PWD/media/bench-1080p60.mp4}"
if [ -n "${SPIKE_HDR:-}" ]; then export SPIKE_HDR_MEDIA="$PWD/media/hdr10.mp4" SPIKE_HDR_HOLD=3; fi
# Muted, but still through CoreAudio, so mpv keeps a real audio clock.
export SPIKE_MPV_ARGS="--mute=yes ${SPIKE_MPV_ARGS:-}"

log="$out/$name.log"
perl -e 'alarm shift; exec @ARGV' 300 ./bin/spike >"$log" 2>&1 &
app=$!
wait_for() {
  for _ in $(seq 1 1500); do
    grep -q "$1" "$log" && return 0
    kill -0 "$app" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}
[ -z "${SPIKE_SKIP_FULLSCREEN:-}" ] && wait_for SPIKE_FULLSCREEN && screencapture -x "$out/$name-fullscreen.png"
[ -n "${SPIKE_HDR:-}" ] && wait_for SPIKE_HDR_READY && screencapture -x -R100,100,1280,720 "$out/$name-hdr.png"
wait_for SPIKE_READY_FOR_SCREENSHOT && sleep 0.5 && screencapture -x -R100,100,1280,720 "$out/$name.png"
wait "$app" || true
echo "== $name"
grep '\[spike\] step\|start failed' "$log" | cut -c1-400
# An occluded window isn't drawn at all, so a bench taken while something
# covered it is meaningless: flag it.
python3 - "$out/$name.json" <<'PY'
import json, sys
st = json.load(open(sys.argv[1])).get("video", {}).get("bench", {}).get("windowState", {})
if not all(s.get("visible") for s in st.values()):
    print("WARNING: the window was not visible during the bench:", st)
PY
