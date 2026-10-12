#!/usr/bin/env python3
"""Prints the tables in docs/spikes/baselines.md from results/*.json.

Startup: run 1 is reported on its own ("first launch"); the median is over
runs 2..N. Runs that errored or painted later than 10 s (the window was
occluded or the display slept: an occluded webview doesn't paint) are dropped
and counted. Memory: median over all valid runs at each sample time.
"""
import glob
import json
import os
import statistics
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))
MARKS = ["goInit", "appStarted", "windowShow", "painted", "mpvReady", "homeDecoded"]
MEM = {"darwin": ["footprintCore", "footprint"], "windows": ["privateWS", "private"], "linux": ["pss", "rss"]}


def load(path):
    d = json.load(open(path))
    goos = d["host"]["goos"]
    ok, dropped = [], []
    for r in d["runs"]:
        m = r.get("msFromSpawn") or {}
        if r.get("error") or m.get("painted", 1e9) > 10000:
            dropped.append(r["n"])
        else:
            ok.append(r)
    return d, goos, ok, dropped


def med(xs):
    return statistics.median(xs) if xs else None


def fmt(x, nd=0):
    return "–" if x is None else f"{x:.{nd}f}"


def main():
    files = sys.argv[1:] or sorted(glob.glob("results/*-*.json"))
    print("| label | first launch: painted (ms) | warm p50: goInit / appStarted / windowShow / painted / mpvReady | n warm | dropped | mem +5s | mem +15s | mem +30s |")
    print("|---|---|---|---|---|---|---|---|")
    for f in files:
        if os.path.basename(f).startswith("sizes"):
            continue
        d, goos, ok, dropped = load(f)
        if not ok:
            continue
        first = ok[0] if ok[0]["n"] == 1 else None
        warm = [r for r in ok if r["n"] != 1]
        w = {k: med([r["msFromSpawn"][k] for r in warm if k in r["msFromSpawn"]]) for k in MARKS}
        mems = []
        for i, t in enumerate(("+5s", "+15s", "+30s")):
            vals = []
            for key in MEM[goos]:
                xs = [r["samples"][i]["totalMB"].get(key) for r in ok if len(r["samples"]) > i]
                xs = [x for x in xs if x is not None]
                vals.append(fmt(med(xs)))
            mems.append(" / ".join(vals) if any(v != "–" for v in vals) else "")
        home = f" (home decoded {fmt(w['homeDecoded'])})" if w["homeDecoded"] else ""
        print(f"| {d['label']} | {fmt(first['msFromSpawn']['painted']) if first else 'dropped'} | "
              f"{fmt(w['goInit'])} / {fmt(w['appStarted'])} / {fmt(w['windowShow'])} / **{fmt(w['painted'])}** / {fmt(w['mpvReady'])}{home} | "
              f"{len(warm)} | {dropped or ''} | {' | '.join(mems)} |")
    print()
    print("memory keys:", {k: " / ".join(v) for k, v in MEM.items()}, "(MiB)")


if __name__ == "__main__":
    main()
