#!/usr/bin/env bash
# Builds vinput into $1 (default /tmp/vinput).
set -euo pipefail
cd "$(dirname "$0")"
out=${1:-/tmp/vinput}
mkdir -p "$out"
for p in wlr-virtual-pointer-unstable-v1 virtual-keyboard-unstable-v1; do
  wayland-scanner client-header "$p.xml" "$out/$p-client-protocol.h"
  wayland-scanner private-code "$p.xml" "$out/$p-protocol.c"
done
gcc -O2 -I"$out" vinput.c "$out"/*-protocol.c -o "$out/vinput" $(pkg-config --cflags --libs wayland-client xkbcommon)
