#!/usr/bin/env bash
# Builds the baseline app for this Linux machine's arch and packs it as a .deb
# (GTK, WebKitGTK and libmpv from the distro) and as an AppImage (everything
# bundled, WebKitGTK included), then writes results/sizes-linux.json. With
# flatpak installed, it also records Flathub's sizes for comparable apps.
# Needs: go, wails3 (beta.28), libgtk-4-dev, libwebkitgtk-6.0-dev, libmpv-dev.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=bin/linux
rm -rf "$out" && mkdir -p "$out/bin" results
arch=$(go env GOARCH)

[ -f frontend/dist/index.html ] || (cd frontend && npm install --no-audit --no-fund && npm run build)

flags=(-trimpath -buildvcs=false -ldflags="-w -s")
go build -tags production "${flags[@]}" -o "$out/bin/shell" .
go build -tags production,mpv "${flags[@]}" -o "$out/bin/mpv" .

for v in shell mpv; do
  d="$out/$v"
  mkdir -p "$d"
  cp "$out/bin/$v" "$d/staysh"
  # nfpm needs a value; libc6 is a no-op dependency for the shell.
  dep=libc6
  [ "$v" = mpv ] && dep=$(dpkg -S "$(ldd "$d/staysh" | awk '/libmpv/ {print $1}')" | head -1 | cut -d: -f1)
  # nfpm doesn't expand variables in contents, so fill the template here.
  sed -e "s#\${STAYSH_BIN}#$d/staysh#" -e "s#\${STAYSH_MPV_DEP}#$dep#" scripts/linux/nfpm.yaml > "$d/nfpm.yaml"
  GOARCH="$arch" wails3 tool package -name staysh -format deb -config "$d/nfpm.yaml" -out "$d"
  cp ../../build/appicon.png "$d/staysh.png" # appimagetool wants the desktop file's Icon= name
  wails3 generate appimage -binary "$d/staysh" -icon "$d/staysh.png" \
    -desktopfile scripts/linux/staysh.desktop -outputdir "$d" -builddir "$PWD/$d/appimage-build"
done

flatpak_info() { # ref -> "download installed" in bytes, from Flathub's metadata
  LC_ALL=C flatpak remote-info --user flathub "$1" 2>/dev/null | LC_ALL=C sed 's/[^ -~]/ /g' | awk -F': *' '
    function bytes(s,  n, u) { n = s + 0; u = s; gsub(/[0-9., ]/, "", u)
      return n * (u ~ /^k/ ? 1e3 : u ~ /^M/ ? 1e6 : u ~ /^G/ ? 1e9 : 1) }
    /^ *Download:/ { d = bytes($2) } /^ *Installed:/ { i = bytes($2) } /^ *Runtime:/ { r = $2 }
    END { printf "%d %d %s", d, i, r }'
}
flat="{}"
if command -v flatpak >/dev/null; then
  flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
  flat="{"
  for ref in io.github.celluloid_player.Celluloid io.mpv.Mpv; do
    read -r dl inst rt <<<"$(flatpak_info "app/$ref/x86_64/stable")"
    read -r rdl rinst _ <<<"$(flatpak_info "runtime/$rt")"
    flat+="\"$ref\": {\"downloadBytes\": $dl, \"installedBytes\": $inst, \"runtime\": \"$rt\", \"runtimeDownloadBytes\": $rdl, \"runtimeInstalledBytes\": $rinst},"
  done
  flat="${flat%,}}"
fi

python3 - "$out" "$arch" "$flat" > results/sizes-linux.json <<'PY'
import glob, json, os, subprocess, sys
out, arch, flat = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
def tree_bytes(p):
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs if not os.path.islink(os.path.join(r, f)))
def pkg_version(name):
    return subprocess.run(["dpkg-query", "-W", "-f=${Version}", name], capture_output=True, text=True).stdout
res = {"_arch": arch, "_distro": open("/etc/os-release").read().split("PRETTY_NAME=")[1].split("\n")[0].strip('"'),
       "_versions": {p: pkg_version(p) for p in ("libgtk-4-1", "libwebkitgtk-6.0-4", "libmpv2")}, "_flathub": flat}
for v in ("shell", "mpv"):
    d = os.path.join(out, v)
    deb = glob.glob(os.path.join(d, "*.deb"))[0]
    img = glob.glob(os.path.join(d, "*.AppImage"))[0]
    appdir = glob.glob(os.path.join(d, "appimage-build", "*.AppDir"))[0]
    libs = []
    for r, _, fs in os.walk(appdir):
        for f in fs:
            p = os.path.join(r, f)
            if not os.path.islink(p):
                libs.append((os.path.getsize(p), os.path.relpath(p, appdir)))
    libs.sort(reverse=True)
    res[v] = {
        "exeBytes": os.path.getsize(os.path.join(d, "staysh")),
        "debBytes": os.path.getsize(deb),
        "appImageBytes": os.path.getsize(img),
        "appDirBytes": tree_bytes(appdir),
        "appDirFiles": len(libs),
        "appDirLargest": [{"path": p, "bytes": b} for b, p in libs[:25]],
    }
print(json.dumps(res, indent=2))
PY
python3 - <<'PY'
import json
r = json.load(open("results/sizes-linux.json"))
mb = lambda b: f"{b/1e6:6.1f}"
print(r["_distro"], r["_arch"], r["_versions"])
for v in ("shell", "mpv"):
    x = r[v]
    print(f"{v:6} exe {mb(x['exeBytes'])}  deb {mb(x['debBytes'])}  AppImage {mb(x['appImageBytes'])} (AppDir {mb(x['appDirBytes'])}, {x['appDirFiles']} files)")
    for l in x["appDirLargest"][:12]:
        print(f"         {mb(l['bytes'])}  {l['path']}")
for k, f in r["_flathub"].items():
    print(f"flathub {k}: download {mb(f['downloadBytes'])} installed {mb(f['installedBytes'])} runtime {f['runtime']} ({mb(f['runtimeDownloadBytes'])} download)")
PY
