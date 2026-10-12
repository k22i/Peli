#!/usr/bin/env python3
"""Copy Homebrew's libmpv and every Homebrew dylib it pulls in into an app's
Contents/Frameworks, rewriting install names to @rpath so the bundle is
self-contained (what dylibbundler does). Throwaway; see ../../README.md.

    bundle-brew.py /opt/homebrew/opt/mpv/lib/libmpv.2.dylib bin/X.app/Contents/Frameworks
"""
import os
import shutil
import subprocess
import sys

BREW = "/opt/homebrew/"


def deps(path):
    out = subprocess.run(["otool", "-L", path], capture_output=True, text=True, check=True).stdout
    lines = out.splitlines()[1:]
    return [l.strip().split(" (")[0] for l in lines if l.strip()]


def rpaths(path):
    out = subprocess.run(["otool", "-l", path], capture_output=True, text=True, check=True).stdout.splitlines()
    res = []
    for i, l in enumerate(out):
        if "cmd LC_RPATH" in l:
            res.append(out[i + 2].strip().split("path ")[1].split(" (offset")[0])
    return res


def resolve(ref, origin):
    """Turn a dependency reference into a real file path (or None for system libs)."""
    d = os.path.dirname(origin)
    if ref.startswith("@loader_path/"):
        p = os.path.join(d, ref[len("@loader_path/"):])
    elif ref.startswith("@rpath/"):
        p = None
        for rp in rpaths(origin):
            base = rp.replace("@loader_path", d)
            cand = os.path.join(base, ref[len("@rpath/"):])
            if os.path.exists(cand):
                p = cand
                break
        if p is None:
            raise SystemExit(f"unresolved {ref} from {origin}")
    else:
        p = ref
    p = os.path.realpath(p)
    return p if p.startswith(BREW) else None


def main(root, dest, name="libmpv.dylib"):
    os.makedirs(dest, exist_ok=True)
    seen = {}  # real path -> bundled basename
    queue = [(os.path.realpath(root), name)]
    while queue:
        real, base = queue.pop()
        if real in seen:
            continue
        seen[real] = base
        target = os.path.join(dest, base)
        shutil.copyfile(real, target)
        os.chmod(target, 0o755)
        changes = []
        for ref in deps(real)[1:]:  # the first entry is the dylib's own id
            r = resolve(ref, real)
            if r is None:
                continue
            b = seen.get(r) or os.path.basename(ref)
            changes += ["-change", ref, "@rpath/" + b]
            queue.append((r, b))
        subprocess.run(["install_name_tool", "-id", "@rpath/" + base, *changes, target], check=True, capture_output=True)
        for rp in rpaths(target):
            subprocess.run(["install_name_tool", "-delete_rpath", rp, target], capture_output=True)
        subprocess.run(["install_name_tool", "-add_rpath", "@loader_path", target], check=True, capture_output=True)
        subprocess.run(["codesign", "-f", "-s", "-", target], check=True, capture_output=True)
    print(f"bundled {len(seen)} dylibs into {dest}")


if __name__ == "__main__":
    main(*sys.argv[1:])
