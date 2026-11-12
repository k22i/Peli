#!/usr/bin/env bash
# Builds the spike app for the iOS simulator (default) or a device and, for the
# simulator, installs it. Steps are the ones `wails3 task ios:package` runs, plus
# libmpv.framework (linked, embedded in Frameworks/ and signed).
#
#   ./build.sh [sim|device]
#
# Needs: build/libmpv/build-ios.sh run first, and a wails3 3.1.0 on PATH or in
# $WAILS3 (go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0 with GOBIN
# set to a scratch dir, so the global wails3 stays as it is).
set -euo pipefail
cd "$(dirname "$0")"
plat=${1:-sim}
min=16.0
xcfw=${XCFRAMEWORK:-../../build/libmpv/.work/libmpv.xcframework}
wails3=${WAILS3:-wails3}
name=ioslibmpv
if [ "$plat" = device ]; then
	sdkname=iphoneos; target=arm64-apple-ios$min; slice=ios-arm64; minflag=-miphoneos-version-min=$min
else
	sdkname=iphonesimulator; target=arm64-apple-ios$min-simulator; slice=ios-arm64-simulator; minflag=-mios-simulator-version-min=$min
fi
sdk=$(xcrun --sdk $sdkname --show-sdk-path)

rm -rf .fw && mkdir .fw && cp -R "$xcfw/$slice/libmpv.framework" .fw/

mkdir -p bin
"$wails3" ios overlay:gen -out build/ios/xcode/overlay.json -config build/config.yml
"$wails3" ios xcode:gen -outdir build/ios/xcode -config build/config.yml

export GOOS=ios GOARCH=arm64 CGO_ENABLED=1
export CGO_CFLAGS="-isysroot $sdk -target $target $minflag"
export CGO_LDFLAGS="-isysroot $sdk -target $target"
go build -buildmode=c-archive -overlay build/ios/xcode/overlay.json -tags ios,debug \
	-buildvcs=false -gcflags=all="-l" -o bin/$name.a .

main_m=build/ios/xcode/main/main.m
[ -f "$main_m" ] || main_m=build/ios/main.m
xcrun -sdk $sdkname clang -target $target -isysroot "$sdk" \
	-framework Foundation -framework UIKit -framework WebKit -framework Security -framework CoreFoundation \
	-framework UniformTypeIdentifiers -framework LocalAuthentication -framework UserNotifications \
	-framework AVFoundation -framework CoreLocation -framework CoreMotion -framework SystemConfiguration \
	-framework OpenGLES -framework QuartzCore \
	-F .fw -framework libmpv -Wl,-rpath,@executable_path/Frameworks \
	-lresolv -o bin/$name "$main_m" -Wl,-force_load,bin/$name.a

app=bin/$name.app
rm -rf $app && mkdir -p $app/Frameworks
cp bin/$name $app/
cp build/ios/Info.plist $app/
cp -R .fw/libmpv.framework $app/Frameworks/
codesign --force --sign - $app/Frameworks/libmpv.framework
codesign --force --sign - $app
ls -l bin/$name | awk '{print "executable", $5, "bytes"}'
echo "built $app ($plat)"
