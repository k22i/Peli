#!/usr/bin/env bash
# Runs the launcher against the Linux builds from package.sh under Xvfb (no
# GPU: WebKitGTK renders in software). RUNS (default 10) launches each.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -z "${DISPLAY:-}" ]; then
  exec dbus-run-session -- xvfb-run -a -s "-screen 0 1920x1080x24" "$0" "$@"
fi
runs=${RUNS:-10}
b=bin/linux
mkdir -p results
go build -o bin/bench ./bench
run() { # app label [extra flags]
  local app=$1 label=$2
  shift 2
  ./bin/bench -app "$app" -label "$label" -out "results/$label.json" -runs "$runs" "$@" 2>&1 | grep -E "run [0-9]+:"
}
run "$b/bin/shell" linux-shell
run "$b/bin/mpv" linux-mpv
run "$(ls "$b"/mpv/*.AppImage)" linux-mpv-appimage
runs=3 run "$b/bin/mpv" linux-mpv-home -page home -samples 5s,15s,30s
