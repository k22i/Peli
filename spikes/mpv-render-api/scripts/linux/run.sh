#!/usr/bin/env bash
# Runs the spike self-test inside the Docker image (see Dockerfile) and saves
# results/<name>.json, .png and .log.
#
#   scripts/linux/run.sh wayland glarea       # sway headless, GtkGLArea under the webview
#   scripts/linux/run.sh wayland subsurface   # sway headless, our own wl_subsurface
#   scripts/linux/run.sh wayland sw
#   scripts/linux/run.sh x11 glarea           # Xvfb + openbox + picom
#   scripts/linux/run.sh x11 sw
#   scripts/linux/run.sh x11 wid              # #3 baseline: mpv's X window (covers the UI)
#   scripts/linux/run.sh x11 overlay          # #3 baseline as shipped: wid + overlay window
#
# Extra env is passed through (SPIKE_NO_BLOCK=1, SPIKE_BENCH_SECS, ...); a
# third argument renames the result files.
set -euo pipefail
session=${1:-wayland}
mode=${2:-glarea}
name="linux-${session}-${3:-$mode}"
cd "$(dirname "$0")/../.."
mkdir -p results bin
out="$PWD/results"

[ -x bin/spike-linux ] || go build -o bin/spike-linux .
[ -x /tmp/vinput/vinput ] || scripts/linux/vinput/build.sh /tmp/vinput

export XDG_RUNTIME_DIR=/tmp/xdg-$$ && mkdir -p -m 700 "$XDG_RUNTIME_DIR"
export LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1 GTK_A11Y=none
# bubblewrap cannot create namespaces inside an unprivileged container.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export SPIKE_MODE="$mode" SPIKE_SELFTEST="$out/$name.json" SPIKE_HOLD=4 SPIKE_EXIT=1 SPIKE_INPUT_WAIT=8
export SPIKE_WINDOW_X=0 SPIKE_WINDOW_Y=0 SPIKE_MEDIA="$PWD/media/test.mp4" SPIKE_FULLSCREEN_HOLD=2
export SPIKE_MPV_LOG="$out/$name.mpv.log"
# No sound card: without a null AO mpv deselects audio. No GPU: --gpu-sw lets
# mpv accept llvmpipe. The wid baseline must pin the X11 context (#2 gotcha 1).
export SPIKE_MPV_ARGS="--ao=null --gpu-sw ${SPIKE_MPV_ARGS:-}"
case "$mode" in wid | overlay) export SPIKE_MPV_ARGS="$SPIKE_MPV_ARGS --vo=gpu-next --gpu-context=x11egl" ;; esac

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT

case "$session" in
x11)
  Xvfb :99 -screen 0 1600x900x24 -nolisten tcp & pids+=($!)
  xvfb=$!
  export DISPLAY=:99 GDK_BACKEND=x11 XDG_SESSION_TYPE=x11
  sleep 1
  openbox >/dev/null 2>&1 & pids+=($!)
  picom --backend xrender --no-fading-openclose >/dev/null 2>&1 & pids+=($!)
  picom=$!
  sleep 0.5
  export SPIKE_SYSTEM_PIDS="Xvfb=$xvfb,picom=$picom"
  ;;
wayland)
  WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
    sway ${SPIKE_SWAY_DEBUG:+-d} -c scripts/linux/sway.conf >"$out/$name.sway.log" 2>&1 & pids+=($!)
  sway=$!
  for _ in $(seq 1 50); do ls "$XDG_RUNTIME_DIR"/wayland-* >/dev/null 2>&1 && break; sleep 0.1; done
  export WAYLAND_DISPLAY=$(basename "$(ls "$XDG_RUNTIME_DIR"/wayland-* | grep -v lock | head -1)")
  export SWAYSOCK=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock | head -1)
  export GDK_BACKEND=wayland XDG_SESSION_TYPE=wayland
  unset DISPLAY
  export SPIKE_SYSTEM_PIDS="sway=$sway"
  ;;
esac

log="$out/$name.log"
./bin/spike-linux >"$log" 2>&1 & app=$!
pids+=($app)

wait_for() { timeout "$2" bash -c "until grep -q '$1\|start failed' '$log'; do sleep 0.2; done" && grep -q "$1" "$log"; }
shot() {
  case "$session" in
  x11) import -window root "$1" ;;
  wayland) grim "$1" ;;
  esac
}

if [ -z "${SPIKE_SKIP_FULLSCREEN:-}" ] && wait_for SPIKE_FULLSCREEN 150; then shot "$out/$name-fullscreen.png"; fi
if wait_for SPIKE_READY_FOR_INPUT 150; then
  # Where the webview sits inside the window (header bar, CSD shadow).
  read -r ox oy sx sy < <(grep -o 'SPIKE_WEBVIEW_ORIGIN.*' "$log" | head -1 | cut -d' ' -f2-)
  # The probe box in the centre, the play/pause button bottom-left (twice),
  # an empty area of the video, then a key. Positions are in webview pixels.
  probes=("640 360" "34 690" "34 690" "1000 250")
  case "$session" in
  x11)
    win=$(xdotool search --name "Staysh spike: mpv render API" | head -1)
    # xdotool is relative to the X window, which includes any CSD shadow.
    for pt in "${probes[@]}"; do
      set -- $pt
      xdotool mousemove --window "$win" $(($1 + ox + sx)) $(($2 + oy + sy)) click 1; sleep 0.6
    done
    xdotool key x; sleep 0.4
    ;;
  wayland)
    # sway puts the window geometry (shadow excluded) at 0,0. vinput keeps a
    # virtual pointer and keyboard alive while it clicks (see vinput.c).
    {
      echo "sleep 800"
      for pt in "${probes[@]}"; do
        set -- $pt
        echo "move $(($1 + ox)) $(($2 + oy))"; echo "sleep 200"; echo "click"; echo "sleep 600"
      done
      echo "key 45"; echo "sleep 400" # KEY_X
    } | /tmp/vinput/vinput 1600 900
    ;;
  esac
fi
if wait_for SPIKE_READY_FOR_SCREENSHOT 60; then sleep 1; shot "$out/$name.png"; fi

wait "$app" || true
echo "== $name"
grep '\[spike\] step\|start failed' "$log" | cut -c1-400 || tail -20 "$log"
