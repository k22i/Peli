#!/usr/bin/env bash
# Baseline for the macOS bench: the mpv binary on its own, in its own
# 1280x720 window, playing the same clip. Measures the CPU of mpv and
# WindowServer and the GPU's "Device Utilization %", like the spike's bench.
#
#   scripts/macos/bench-mpv.sh gpu-next   # mpv's default: vo=gpu-next on Metal (MoltenVK)
#   scripts/macos/bench-mpv.sh libmpv     # vo=libmpv: mpv's own CAOpenGLLayer render-API path (cocoa-cb)
set -euo pipefail
vo=${1:-gpu-next}
secs=${SPIKE_BENCH_SECS:-10}
cd "$(dirname "$0")/../.."
out="$PWD/results"
media="${SPIKE_BENCH_MEDIA:-$PWD/media/bench-1080p60.mp4}"
sock=$(mktemp -u /tmp/spike-mpv.XXXX)

cpu() { ps -o time= -p "$1" | awk -F: '{ s = 0; for (i = 1; i <= NF; i++) s = s * 60 + $i; print s }'; }
gpu() { ioreg -r -d 1 -w 0 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*' | head -1 | cut -d= -f2; }
prop() { echo "{\"command\":[\"get_property\",\"$1\"]}" | nc -U "$sock" | head -1 | sed 's/.*"data":\([^,}]*\).*/\1/'; }

ws=$(pgrep -x WindowServer)
mpv --no-config --hwdec=auto-safe --mute=yes --loop-file=inf --vo="$vo" --geometry=1280x720+100+100 \
  --input-ipc-server="$sock" "$media" >/dev/null 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; rm -f "$sock"' EXIT
sleep 3
now() { python3 -c 'import time; print(time.time())'; }
# window <secs>: prints "elapsed mpvCPU windowServerCPU gpuSamples..."
window() {
  local m0 w0 t0 m1 w1 t1 s=() end=$((SECONDS + $1))
  m0=$(cpu $pid); w0=$(cpu "$ws"); t0=$(now)
  while [ $SECONDS -lt $end ]; do s+=("$(gpu)"); sleep 0.5; done
  m1=$(cpu $pid); w1=$(cpu "$ws"); t1=$(now)
  python3 -c "import sys; t0,t1,m0,m1,w0,w1=map(float,sys.argv[1:7]); print(round(t1-t0,2), round(m1-m0,3), round(w1-w0,3), ' '.join(sys.argv[7:]))" \
    "$t0" "$t1" "$m0" "$m1" "$w0" "$w1" "${s[@]}"
}
prop pause >/dev/null
echo '{"command":["set_property","pause",true]}' | nc -U "$sock" >/dev/null
sleep 0.5
paused=$(window 4)
echo '{"command":["set_property","pause",false]}' | nc -U "$sock" >/dev/null
sleep 1
d0=$(prop frame-drop-count); v0=$(prop vo-delayed-frame-count)
play=$(window "$secs")
d1=$(prop frame-drop-count); v1=$(prop vo-delayed-frame-count)
hw=$(prop hwdec-current); cvo=$(prop current-vo)
python3 - "$vo" "$cvo" "$hw" "$d0" "$d1" "$v0" "$v1" "$paused" "$play" >"$out/macos-mpv-$vo.json" <<'PY'
import json, statistics, sys
vo, cvo, hw, d0, d1, v0, v1, paused, play = sys.argv[1:]
num = lambda s: int(s) if s.strip().lstrip('-').isdigit() else 0
def win(s):
    f = s.split()
    el, m, w = float(f[0]), float(f[1]), float(f[2])
    gpu = [int(x) for x in f[3:]]
    return {"secs": el, "cpuPct": {"mpv": round(m / el * 100, 2), "WindowServer": round(w / el * 100, 2),
            "total": round((m + w) / el * 100, 2)},
            "gpuUtilPct": {"n": len(gpu), "mean": round(statistics.mean(gpu), 2) if gpu else None}}
print(json.dumps({"vo": vo, "currentVo": cvo.strip('"'), "hwdec": hw.strip('"'),
                  "frameDrops": num(d1) - num(d0), "voDelayed": num(v1) - num(v0),
                  "playing": win(play), "paused": win(paused)}, indent=2))
PY
cat "$out/macos-mpv-$vo.json"
