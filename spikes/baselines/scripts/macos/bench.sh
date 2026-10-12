#!/usr/bin/env bash
# Runs the launcher against the macOS bundles from package.sh, launching them
# through LaunchServices (`open`) like a Dock or Finder launch. Keep the
# machine otherwise idle-ish and don't cover the window: an occluded webview
# may not paint. RUNS (default 10) launches each.
set -euo pipefail
cd "$(dirname "$0")/../.."
runs=${RUNS:-10}
b=bin/macos
go build -o bin/bench ./bench
run() { # variant label [extra flags]
  local app=$b/$1/Staysh.app label=$2
  shift 2
  ./bin/bench -app "$app" -launch open -label "$label" -out "results/$label.json" -runs "$runs" "$@" 2>&1 | grep -E "run [0-9]+:"
}
run shell-arm64 macos-shell
run mpv-mediakit-arm64 macos-mpv-mediakit
run mpv-brew-arm64 macos-mpv-brew
run mpv-mediakit-universal macos-mpv-mediakit-universal
runs=3 run mpv-mediakit-arm64 macos-mpv-mediakit-home -page home -samples 5s,15s,30s
