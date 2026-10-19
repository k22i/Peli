#!/usr/bin/env bash
# Cross-builds the baseline app for windows/amd64 on Linux (mingw-w64), packs
# it with each libmpv build into NSIS installers (zlib = the app's current
# project.nsi, and solid LZMA) and writes results/sizes-windows.json.
# Needs: go, node, wails3 (beta.28), x86_64-w64-mingw32-gcc, makensis, 7z, zip.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
out=bin/windows
rm -rf "$out" && mkdir -p "$out/bin" lib/dl results

# name|repo|tag|asset. All three ship libmpv as one self-contained libmpv-2.dll.
LIBS=(
  "shinchiro|shinchiro/mpv-winbuild-cmake|20261012|mpv-dev-x86_64-20261012-git-88eb9f2e73.7z"
  "zhongfly-lgpl|zhongfly/mpv-winbuild|2026-10-11-d94d095814|mpv-dev-lgpl-x86_64-20261011-git-d94d095814.7z"
  "mediakit|media-kit/libmpv-win32-video-build|2023-09-24|mpv-dev-x86_64-20230924-git-652a1dd.7z"
)
for l in "${LIBS[@]}"; do
  IFS='|' read -r name repo tag asset <<<"$l"
  if [ ! -f "lib/win-$name/libmpv-2.dll" ]; then
    [ -f "lib/dl/$asset" ] || gh release download "$tag" --repo "$repo" -p "$asset" -D lib/dl
    7z x -y -o"lib/win-$name" "lib/dl/$asset" >/dev/null
  fi
done

[ -f frontend/dist/index.html ] || (cd frontend && npm install --no-audit --no-fund && npm run build)

wails3 generate syso -arch amd64 -icon ../../build/windows/icon.ico -manifest ../../build/windows/wails.exe.manifest \
  -info ../../build/windows/info.json -out wails_windows_amd64.syso
trap 'rm -f wails_windows_amd64.syso' EXIT
export GOOS=windows GOARCH=amd64
flags=(-trimpath -buildvcs=false -ldflags="-w -s -H windowsgui")
CGO_ENABLED=0 go build -tags production "${flags[@]}" -o "$out/bin/shell.exe" .
# Every variant is ABI-compatible at the client API level, so one exe linked
# against shinchiro's import library loads any of the three DLLs.
CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc CGO_CFLAGS="-I$root/lib/win-shinchiro/include" CGO_LDFLAGS="-L$root/lib/win-shinchiro" \
  go build -tags production,mpv "${flags[@]}" -o "$out/bin/mpv.exe" .
unset GOOS GOARCH

nsis=$(mktemp -d)
cp ../../build/windows/nsis/wails_tools.nsh ../../build/windows/icon.ico scripts/windows/installer.nsi "$nsis/"
wails3 generate webview2bootstrapper -dir "$nsis"

stage() { # variant exe [dll dir]
  local d="$out/$1"
  mkdir -p "$d/app"
  cp "$2" "$d/app/sinag.exe"
  [ -n "${3:-}" ] && cp "$3/libmpv-2.dll" "$d/app/"
  makensis -V2 -DSRC="$root/$d/app" -DOUT="$root/$d/sinag-zlib-installer.exe" "$nsis/installer.nsi"
  makensis -V2 -DSRC="$root/$d/app" -DOUT="$root/$d/sinag-lzma-installer.exe" -DSOLID_LZMA "$nsis/installer.nsi"
  (cd "$d/app" && zip -q -9 -r ../sinag-portable.zip .)
}
stage shell "$out/bin/shell.exe"
stage mpv-shinchiro "$out/bin/mpv.exe" lib/win-shinchiro
stage mpv-zhongfly-lgpl "$out/bin/mpv.exe" lib/win-zhongfly-lgpl
stage mpv-mediakit "$out/bin/mpv.exe" lib/win-mediakit

python3 - "$out" "$nsis/MicrosoftEdgeWebview2Setup.exe" > results/sizes-windows.json <<'PY'
import json, os, subprocess, sys
out, boot = sys.argv[1], sys.argv[2]
res = {"_webview2BootstrapperBytes": os.path.getsize(boot)}
for v in sorted(os.listdir(out)):
    d = os.path.join(out, v)
    if v == "bin" or not os.path.isdir(d):
        continue
    app = os.path.join(d, "app")
    dll = os.path.join(app, "libmpv-2.dll")
    r = {
        "exeBytes": os.path.getsize(os.path.join(app, "sinag.exe")),
        "dllBytes": os.path.getsize(dll) if os.path.exists(dll) else 0,
        "zlibInstallerBytes": os.path.getsize(os.path.join(d, "sinag-zlib-installer.exe")),
        "lzmaInstallerBytes": os.path.getsize(os.path.join(d, "sinag-lzma-installer.exe")),
        "portableZipBytes": os.path.getsize(os.path.join(d, "sinag-portable.zip")),
    }
    if os.path.exists(dll):
        imp = subprocess.run(["x86_64-w64-mingw32-objdump", "-p", dll], capture_output=True, text=True).stdout
        r["dllImports"] = sorted({l.split("DLL Name:")[1].strip() for l in imp.splitlines() if "DLL Name:" in l})
        strings = subprocess.run(["strings", "-n", "8", dll], capture_output=True, text=True).stdout.splitlines()
        r["mpvVersion"] = next((s for s in strings if s.startswith("mpv v") or s.startswith("mpv 0.")), None)
    res[v] = r
print(json.dumps(res, indent=2))
PY
python3 - <<'PY'
import json
for v, r in json.load(open("results/sizes-windows.json")).items():
    if v.startswith("_"):
        continue
    mb = lambda b: f"{b/1e6:6.1f}"
    print(f"{v:20} exe {mb(r['exeBytes'])} dll {mb(r['dllBytes'])}  nsis zlib {mb(r['zlibInstallerBytes'])} lzma {mb(r['lzmaInstallerBytes'])}  zip {mb(r['portableZipBytes'])}  {r.get('mpvVersion')}  vulkan={'vulkan-1.dll' in r.get('dllImports', [])}")
PY
