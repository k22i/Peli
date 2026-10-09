#!/usr/bin/env bash
# Runs the spike self-test inside the Docker image (see Dockerfile) on X11
# (Xvfb + openbox + picom) and saves results/<name>.json, .png and .log.
#
#   scripts/linux/run.sh single                # one window
#   scripts/linux/run.sh overlay               # React UI in a 2nd transparent window
#   LC_ALL=de_DE.UTF-8 SPIKE_KEEP_LOCALE=1 scripts/linux/run.sh single locale-unfixed
set -euo pipefail
mode=${1:-single}
name="linux-x11-${2:-$mode}"
cd "$(dirname "$0")/../.."
mkdir -p results bin
out="$PWD/results"

[ -x bin/spike-linux ] || go build -o bin/spike-linux .

export XDG_RUNTIME_DIR=/tmp/xdg && mkdir -p -m 700 "$XDG_RUNTIME_DIR"
export LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1 GTK_A11Y=none
# bubblewrap cannot create namespaces inside an unprivileged container.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export SPIKE_MODE="$mode" SPIKE_SELFTEST="$out/$name.json" SPIKE_HOLD=6 SPIKE_EXIT=1
export SPIKE_WINDOW_X=0 SPIKE_WINDOW_Y=0 SPIKE_MEDIA="$PWD/media/test.mp4"
export SPIKE_MPV_LOG="$out/$name.mpv.log" SPIKE_INPUT_WAIT=5
# No sound card: without a null AO mpv deselects audio. No GPU: --gpu-sw lets
# libplacebo accept llvmpipe, and the context must be pinned or mpv falls
# back to vo=sdl, which ignores wid (#2 gotcha 1).
export SPIKE_MPV_ARGS="--ao=null --gpu-sw --vo=gpu-next --gpu-context=x11egl ${SPIKE_MPV_ARGS:-}"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT

Xvfb :99 -screen 0 1600x900x24 -nolisten tcp & pids+=($!)
export DISPLAY=:99 GDK_BACKEND=x11 XDG_SESSION_TYPE=x11
sleep 1
openbox >/dev/null 2>&1 & pids+=($!)
picom --backend xrender --no-fading-openclose >/dev/null 2>&1 & pids+=($!)
sleep 0.5

log="$out/$name.log"
./bin/spike-linux >"$log" 2>&1 & app=$!
pids+=($app)

if timeout 120 bash -c "until grep -q 'SPIKE_READY_FOR_INPUT\|start failed' '$log'; do sleep 0.2; done" &&
  grep -q SPIKE_READY_FOR_INPUT "$log"; then
  # Coordinates are relative to the main 1280x720 window, so in overlay mode
  # they land on whatever is stacked on top: the probe box in the centre,
  # the play/pause button bottom-left, then an empty area over the video.
  win=$(xdotool search --name "Staysh spike: libmpv" | head -1)
  xdotool mousemove --window "$win" 640 360 click 1; sleep 0.4
  xdotool mousemove --window "$win" 34 690 click 1; sleep 0.6
  xdotool mousemove --window "$win" 34 690 click 1; sleep 0.6
  xdotool mousemove --window "$win" 1000 250 click 1; sleep 0.4
  xdotool key x; sleep 0.4
  xwininfo -root -tree >"$out/$name.xtree.txt" 2>&1 || true
fi

timeout 30 bash -c "until grep -q 'SPIKE_READY_FOR_SCREENSHOT\|start failed' '$log'; do sleep 0.2; done" || true
sleep 1
import -window root "$out/$name.png"
if [ "$mode" = overlay ] && [ -n "${win:-}" ]; then
  # Does the overlay window follow when the user moves / resizes the player?
  xdotool windowmove "$win" 200 120 windowsize "$win" 1000 600; sleep 1.5
  import -window root "$out/$name-moved.png"
fi

wait "$app" || true
echo "== $name"
grep '\[spike\] step\|\[spike\] embed\|start failed\|Non-C locale' "$log" || tail -20 "$log"
