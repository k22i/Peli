#!/usr/bin/env bash
# Plays one fixture in the simulator, screenshots each "snap" the app reports,
# and copies the app's result file and mpv log into results/.
#   scripts/run-case.sh <device-udid> <label> <url> [steps] [hwdec] [mpv opts k=v;k=v] [layer scale]
set -euo pipefail
cd "$(dirname "$0")/.."
dev=$1 label=$2 url=$3 steps=${4:-} hwdec=${5:-} opts=${6:-} scale=${7:-}
id=app.peli.libmpvspike
xcrun simctl terminate "$dev" $id 2>/dev/null || true
c=$(xcrun simctl get_app_container "$dev" $id data)
rm -f "$c"/Documents/result-* "$c"/Documents/marker-* "$c"/Documents/log-*
SIMCTL_CHILD_LIBMPV_URL=$url SIMCTL_CHILD_LIBMPV_LABEL=$label SIMCTL_CHILD_LIBMPV_STEPS=$steps SIMCTL_CHILD_LIBMPV_HWDEC=$hwdec SIMCTL_CHILD_LIBMPV_OPTS=$opts SIMCTL_CHILD_LIBMPV_SCALE=$scale SIMCTL_CHILD_LIBMPV_LOGLEVEL=${LOGLEVEL:-info} \
	xcrun simctl launch "$dev" $id > /dev/null
seen=""
for _ in $(seq 1 240); do
	for m in "$c"/Documents/marker-"$label"-*; do
		[ -e "$m" ] || continue
		n=${m##*marker-$label-}
		case " $seen " in *" $n "*) continue ;; esac
		seen="$seen $n"
		[ "$n" = done ] || xcrun simctl io "$dev" screenshot "results/$label-$n.png" > /dev/null 2>&1
	done
	case " $seen " in *" done "*) break ;; esac
	sleep 1
done
cp "$c/Documents/result-$label.jsonl" "results/$label.jsonl"
cp "$c/Documents/log-$label.txt" "results/$label.log" 2>/dev/null || true
echo "$label: $seen"
