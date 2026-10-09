#!/usr/bin/env bash
# The full Linux matrix in one container: every mode on Wayland and X11 with
# the 10s bench, plus the GtkGLArea scheduling variants.
set -uo pipefail
cd "$(dirname "$0")/../.."
go build -o bin/spike-linux .
for session in wayland x11; do
  modes="glarea gltex sw"
  [ "$session" = wayland ] && modes="$modes subsurface" || modes="$modes wid overlay"
  for mode in $modes; do scripts/linux/run.sh "$session" "$mode"; done
  # GtkGLArea redraws scheduled above GTK's redraw priority (and Wails' idle
  # main-thread dispatch), with and without mpv blocking for the frame time.
  SPIKE_HIGH_PRIO=1 scripts/linux/run.sh "$session" glarea glarea-highprio
  SPIKE_HIGH_PRIO=1 SPIKE_NO_BLOCK=1 scripts/linux/run.sh "$session" glarea glarea-noblock-highprio
done
