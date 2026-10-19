#!/usr/bin/env bash
# Builds the baseline app for macOS in several libmpv variants, packs each
# into a .app and into DMGs (UDZO = what `wails3 tool package` makes, ULFO,
# ULMO), and writes results/sizes-macos.json. Needs Homebrew mpv (headers, and
# the "brew" variant) and Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
MK=v0.7.3 # media-kit/libmpv-darwin-build release
out=bin/macos
rm -rf "$out" && mkdir -p "$out/bin" lib results

# media-kit's LGPL libmpv builds: mpv 0.36, trimmed FFmpeg 6.0.
for v in macos-arm64-video-default macos-arm64-video-full macos-universal-video-default; do
  if [ ! -d "lib/mediakit-$v" ]; then
    gh release download "$MK" --repo media-kit/libmpv-darwin-build -p "libmpv-libs_${MK}_$v.tar.gz" -D lib --clobber
    mkdir -p "lib/mediakit-$v" && tar -xzf "lib/libmpv-libs_${MK}_$v.tar.gz" -C "lib/mediakit-$v" --strip-components 1
  fi
done

[ -f frontend/dist/index.html ] || (cd frontend && npm install --no-audit --no-fund && npm run build)

export CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=12.0
flags=(-tags production -trimpath -buildvcs=false -ldflags="-w -s")
for arch in arm64 amd64; do
  GOARCH=$arch CGO_CFLAGS="-mmacosx-version-min=12.0" CGO_LDFLAGS="-mmacosx-version-min=12.0" \
    go build "${flags[@]}" -o "$out/bin/shell-$arch" .
  # Link against media-kit's universal libmpv (both slices), headers from Homebrew.
  GOARCH=$arch CGO_CFLAGS="-mmacosx-version-min=12.0 -I/opt/homebrew/include" \
    CGO_LDFLAGS="-mmacosx-version-min=12.0 -L$root/lib/mediakit-macos-universal-video-default -Wl,-rpath,@executable_path/../Frameworks" \
    go build "${flags[@]/production/production,mpv}" -o "$out/bin/mpv-$arch" .
done
lipo -create -output "$out/bin/shell-universal" "$out/bin/shell-arm64" "$out/bin/shell-amd64"
lipo -create -output "$out/bin/mpv-universal" "$out/bin/mpv-arm64" "$out/bin/mpv-amd64"

bundle() { # name binary [frameworks source dir]
  local app="$out/$1/Cove.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$2" "$app/Contents/MacOS/cove-baseline"
  cp ../../build/darwin/icons.icns "$app/Contents/Resources/"
  sed -e 's#<string>cove</string>#<string>cove-baseline</string>#' \
      -e 's#<string>My Product</string>#<string>Cove</string>#' \
      -e 's#k22i.net.cove#k22i.net.cove.baseline#' ../../build/darwin/Info.plist > "$app/Contents/Info.plist"
  if [ -n "${3:-}" ]; then
    mkdir -p "$app/Contents/Frameworks"
    cp "$3"/*.dylib "$app/Contents/Frameworks/"
  fi
  if [ -n "${BREW:-}" ]; then
    python3 scripts/macos/bundle-brew.py /opt/homebrew/opt/mpv/lib/libmpv.2.dylib "$app/Contents/Frameworks"
  fi
  xattr -cr "$app"
  codesign --force --deep --sign - "$app" 2>/dev/null
  codesign --verify --deep --strict "$app"
}

bundle shell-arm64 "$out/bin/shell-arm64"
bundle shell-universal "$out/bin/shell-universal"
bundle mpv-mediakit-arm64 "$out/bin/mpv-arm64" lib/mediakit-macos-arm64-video-default
bundle mpv-mediakit-full-arm64 "$out/bin/mpv-arm64" lib/mediakit-macos-arm64-video-full
bundle mpv-mediakit-universal "$out/bin/mpv-universal" lib/mediakit-macos-universal-video-default
BREW=1 bundle mpv-brew-arm64 "$out/bin/mpv-arm64"

# Control: plain Cocoa + WKWebView, no Wails/Go/React (bench only, not packaged).
c="$out/control/Cove.app/Contents"
mkdir -p "$c/MacOS"
clang -fobjc-arc -O2 -mmacosx-version-min=12.0 -framework Cocoa -framework WebKit scripts/macos/control/main.m -o "$c/MacOS/cove-control"
sed -e 's#<string>cove</string>#<string>cove-control</string>#' -e 's#<string>My Product</string>#<string>Cove control</string>#' \
    -e 's#k22i.net.cove#k22i.net.cove.control#' ../../build/darwin/Info.plist > "$c/Info.plist"
codesign --force --deep --sign - "$out/control/Cove.app"

for d in "$out"/*/; do
  case "$(basename "$d")" in bin | control) continue ;; esac
  v=$(basename "$d")
  stage=$(mktemp -d)
  cp -R "$d/Cove.app" "$stage/"
  ln -s /Applications "$stage/Applications"
  for f in UDZO ULFO ULMO; do
    hdiutil create -quiet -volname Cove -srcfolder "$stage" -ov -format "$f" "$d/Cove-$f.dmg"
  done
  rm -rf "$stage"
done

python3 - "$out" > results/sizes-macos.json <<'PY'
import json, os, subprocess, sys
out = sys.argv[1]
def tree_bytes(p):
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs if not os.path.islink(os.path.join(r, f)))
res = {}
for v in sorted(os.listdir(out)):
    d = os.path.join(out, v)
    if not os.path.isdir(d) or v in ("bin", "control"):
        continue
    app = os.path.join(d, "Cove.app")
    fw = os.path.join(app, "Contents", "Frameworks")
    exe = os.path.join(app, "Contents", "MacOS", "cove-baseline")
    lipo = subprocess.run(["lipo", "-archs", exe], capture_output=True, text=True).stdout.strip()
    res[v] = {
        "archs": lipo,
        "exeBytes": os.path.getsize(exe),
        "frameworksBytes": tree_bytes(fw) if os.path.isdir(fw) else 0,
        "frameworksFiles": len(os.listdir(fw)) if os.path.isdir(fw) else 0,
        "appBytes": tree_bytes(app),
        "dmgBytes": {f: os.path.getsize(os.path.join(d, f"Cove-{f}.dmg")) for f in ("UDZO", "ULFO", "ULMO")},
    }
print(json.dumps(res, indent=2))
PY
python3 - <<'PY'
import json
for v, r in json.load(open("results/sizes-macos.json")).items():
    mb = lambda b: f"{b/1e6:6.1f}"
    print(f"{v:26} {r['archs']:13} exe {mb(r['exeBytes'])}  libs {mb(r['frameworksBytes'])} ({r['frameworksFiles']:3})  app {mb(r['appBytes'])}  dmg " + " ".join(f"{k} {mb(b)}" for k, b in r['dmgBytes'].items()))
PY
