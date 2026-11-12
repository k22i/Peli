#!/usr/bin/env python3
"""Prints one line per snapshot of every results/<prefix>-*.jsonl."""
import glob, json, sys
for f in sorted(glob.glob(f"results/{sys.argv[1]}-*.jsonl")):
    print("==", f)
    for l in open(f):
        try:
            d = json.loads(l)
        except Exception:
            continue
        if d["step"].startswith("snap"):
            r = d["render"]
            print(f'  {d["step"]:12} t={float(d["time-pos"] or 0):6.1f} pause={d["pause"]:3} aid={d["aid"]:3} sid={d["sid"]:3} hw={d["hwdec-current"]:18} '
                  f'{d["video-format"]}/{d["audio-codec-name"]:5} drop={d["frame-drop-count"]:>4} frames={r["frames"]:>4} render={r["avgRenderMs"]:6.1f}ms cpu={d["cpuPercentSinceStart"]:5.0f}% '
                  f'drawable={r["drawableW"]}x{r["drawableH"]}')
