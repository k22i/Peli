#!/usr/bin/env bash
# Runs the spike self-test inside the Docker image (see Dockerfile) and saves
# results/<name>.json, results/<name>.png and results/<name>.log.
#
#   scripts/linux/run.sh x11 single        # Xvfb + picom compositor
#   scripts/linux/run.sh x11 overlay
#   scripts/linux/run.sh wayland single    # headless Weston, native Wayland
#   scripts/linux/run.sh xwayland single   # headless Weston, app + mpv on XWayland
set -euo pipefail
session=${1:-x11}
mode=${2:-single}
name="linux-${session}-${mode}"
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
export SPIKE_MPV_LOG="$out/$name.mpv.log"
# No sound card in the container: without a null AO mpv deselects audio.
# No GPU either: --gpu-sw lets libplacebo accept llvmpipe.
export SPIKE_MPV_ARGS="--ao=null --gpu-sw ${SPIKE_MPV_ARGS:-}"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT

case "$session" in
x11)
  Xvfb :99 -screen 0 1600x900x24 -nolisten tcp & pids+=($!)
  export DISPLAY=:99 GDK_BACKEND=x11 XDG_SESSION_TYPE=x11
  sleep 1
  # A window manager (stacking / WM_TRANSIENT_FOR) and a compositor (what
  # makes ARGB windows such as the overlay window transparent), as on a desktop.
  openbox >/dev/null 2>&1 & pids+=($!)
  picom --backend xrender --no-fading-openclose >/dev/null 2>&1 & pids+=($!)
  sleep 0.5
  export SPIKE_INPUT_WAIT=5
  # Auto-probing rejects llvmpipe as a "software renderer" and falls back to
  # vo=sdl, which ignores --wid. Force the X11 EGL context (real GPUs pass
  # the probe on their own).
  export SPIKE_MPV_ARGS="$SPIKE_MPV_ARGS --vo=gpu-next --gpu-context=x11egl"
  ;;
wayland | xwayland)
  extra=()
  if [ "$session" = xwayland ]; then
    extra+=(--xwayland)
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
  fi
  weston --backend=headless --renderer=pixman --width=1600 --height=900 \
    --socket=wayland-1 --debug --idle-time=0 "${extra[@]}" >"$out/$name.weston.log" 2>&1 & pids+=($!)
  sleep 2
  export WAYLAND_DISPLAY=wayland-1 XDG_SESSION_TYPE=wayland
  if [ "$session" = xwayland ]; then
    export DISPLAY=$(grep -o 'xserver listening on display :[0-9]*' "$out/$name.weston.log" | grep -o ':[0-9]*' | head -1)
    export DISPLAY=${DISPLAY:-:0} GDK_BACKEND=x11
    # mpv would otherwise prefer its Wayland context and ignore --wid.
    export SPIKE_MPV_ARGS="$SPIKE_MPV_ARGS --vo=gpu-next --gpu-context=x11egl"
  else
    export GDK_BACKEND=wayland
  fi
  ;;
esac

log="$out/$name.log"
./bin/spike-linux >"$log" 2>&1 & app=$!
pids+=($app)

if [ "$session" = x11 ]; then
  timeout 60 bash -c "until grep -q SPIKE_READY_FOR_INPUT '$log'; do sleep 0.2; done" || true
  # Pointer probe sits in the centre of the 1280x720 client area; the
  # play/pause button is bottom-left. Coordinates are relative to the main
  # window, so in overlay mode they land on whatever is stacked on top.
  win=$(xdotool search --name "Peli spike: mpv" | head -1)
  xdotool mousemove --window "$win" 640 360 click 1; sleep 0.4
  xdotool mousemove --window "$win" 34 690 click 1; sleep 0.4
  xdotool key x; sleep 0.4
  xwininfo -root -tree >"$out/$name.xtree.txt" 2>&1 || true
fi

timeout 90 bash -c "until grep -q 'SPIKE_READY_FOR_SCREENSHOT\|start failed' '$log'; do sleep 0.2; done" || true
sleep 1
case "$session" in
x11)
  import -window root "$out/$name.png"
  if [ "$mode" = overlay ]; then
    # Does the overlay window follow when the user moves / resizes the player?
    xdotool windowmove "$win" 200 120 windowsize "$win" 1000 600; sleep 1.5
    import -window root "$out/$name-moved.png"
  fi
  ;;
*)
  (cd "$out" && timeout 10 weston-screenshooter >/dev/null 2>&1 || timeout 10 /usr/lib/*/weston/weston-screenshooter >/dev/null 2>&1 || true)
  shot=$(ls -t "$out"/wayland-screenshot-*.png 2>/dev/null | head -1 || true)
  [ -n "$shot" ] && mv "$shot" "$out/$name.png"
  ;;
esac
[ "$session" = xwayland ] && { xwininfo -root -tree >"$out/$name.xtree.txt" 2>&1 || true; }

wait "$app" || true
echo "== $name"
grep '\[spike\] step\|\[spike\] embed' "$log" || tail -20 "$log"
