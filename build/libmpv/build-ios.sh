#!/usr/bin/env bash
# Spike (ios-libmpv): cross-builds our LGPL libmpv (ADR-0003) for iOS from the
# same pins as build.sh (sources.txt), as a dynamic libmpv.xcframework.
#
#   build/libmpv/build-ios.sh [work-dir]           both slices + the xcframework
#   build/libmpv/build-ios.sh ios-arm64 [work-dir] one slice only (also: ios-sim-arm64)
#
# Slices: ios-arm64 (device) and ios-sim-arm64 (Apple-silicon simulator), minimum
# iOS 16. Each is one libmpv.framework (flat, iOS layout) whose binary links every
# dependency in statically (FFmpeg + VideoToolbox, libplacebo, libass, dav1d...),
# so the app embeds one dynamic framework that LGPL users can swap and re-sign.
#
# Render path: the libmpv render API with OpenGL ES (ios-gl: VideoToolbox frames
# are mapped to GLES textures through a CVOpenGLESTextureCache). No Cocoa, Swift,
# CoreAudio (AudioUnit instead), Metal or Vulkan.
#
# Shares sources.txt, the download cache and the src/ checkout with build.sh.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
case ${1:-} in
ios-arm64 | ios-sim-arm64) targets=("$1"); shift ;;
*) targets=(ios-arm64 ios-sim-arm64) ;;
esac
work=${1:-$here/.work}
mkdir -p "$work"
work=$(cd "$work" && pwd)

ios_min=16.0
jobs=$(sysctl -n hw.ncpu 2>/dev/null || nproc)
dl=$work/downloads
src=$work/src
mkdir -p "$dl" "$src"

# --- sources (same as build.sh) ---------------------------------------------

srcdir() {
	local name=$1 version url sum
	read -r version url sum < <(awk -v n="$name" '$1 == n { print $2, $3, $4 }' "$here/sources.txt")
	[ -n "$sum" ] || { echo "build-ios.sh: $name not in sources.txt" >&2; exit 1; }
	local dir=$src/$name-$version
	if [ ! -d "$dir" ]; then
		if [[ $url == git+* ]]; then
			rm -rf "$dir.tmp"
			git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" \
				--recurse-submodules --shallow-submodules "${url#git+}" "$dir.tmp"
			local head
			head=$(git -C "$dir.tmp" rev-parse HEAD)
			[ "$head" = "$sum" ] || { echo "build-ios.sh: $name $version is at $head, pinned $sum" >&2; exit 1; }
		else
			local file=$dl/${url##*/}
			if [ ! -f "$file" ]; then
				curl -fsSL --retry 3 -o "$file.tmp" "$url"
				mv "$file.tmp" "$file"
			fi
			local got
			got=$(shasum -a 256 "$file" | cut -d' ' -f1)
			[ "$got" = "$sum" ] || { echo "build-ios.sh: $file has SHA-256 $got, pinned $sum" >&2; rm -f "$file"; exit 1; }
			rm -rf "$dir.tmp" && mkdir -p "$dir.tmp"
			tar -xf "$file" -C "$dir.tmp" --strip-components 1
		fi
		mv "$dir.tmp" "$dir"
	fi
	echo "$dir"
}
version_of() { awk -v n="$1" '$1 == n { print $2 }' "$here/sources.txt"; }

# Source patches live next to this script; applied once per checkout.
patch_src() {
	local dir=$1 p=$2 stamp
	stamp=$dir/.patched-$(basename "$p")
	[ -f "$stamp" ] && return
	patch -p1 -d "$dir" < "$p" > /dev/null
	touch "$stamp"
}

build_slice() {
	local target=$1 sdkname triple
	case $target in
	ios-arm64) sdkname=iphoneos; triple=arm64-apple-ios$ios_min ;;
	ios-sim-arm64) sdkname=iphonesimulator; triple=arm64-apple-ios$ios_min-simulator ;;
	esac
	local sdk
	sdk=$(xcrun --sdk $sdkname --show-sdk-path)
	local build=$work/$target/build prefix=$work/$target/prefix dist=$work/libmpv-$target
	rm -rf "$dist"
	mkdir -p "$build" "$prefix/lib/pkgconfig"

	export PKG_CONFIG_LIBDIR=$prefix/lib/pkgconfig
	unset PKG_CONFIG_PATH CPATH C_INCLUDE_PATH LIBRARY_PATH MACOSX_DEPLOYMENT_TARGET IPHONEOS_DEPLOYMENT_TARGET SDKROOT
	# mpv's meson adds "-isysroot <macOS SDK>" to every link; point it at ours.
	export MACOS_SDK=$sdk

	local cflags="-target $triple -isysroot $sdk"
	# What ios-gl (EAGLContext) and AudioUnit output (AVAudioSession) need; mpv's
	# meson doesn't link them, and the dylib would silently resolve them at load.
	local ldflags="$cflags -framework Foundation -framework OpenGLES -framework AVFoundation"
	local cross=$work/$target/meson-cross.ini
	cat > "$cross" <<EOF
[binaries]
c = ['clang']
cpp = ['clang++']
objc = ['clang']
ar = 'ar'
strip = 'strip'
pkg-config = ['pkg-config', '--static']

[built-in options]
c_args = [$(printf "'%s', " $cflags)]
cpp_args = [$(printf "'%s', " $cflags)]
objc_args = [$(printf "'%s', " $cflags)]
c_link_args = [$(printf "'%s', " $ldflags)]
cpp_link_args = [$(printf "'%s', " $ldflags)]
objc_link_args = [$(printf "'%s', " $ldflags)]

[properties]
needs_exe_wrapper = true

[host_machine]
system = 'darwin'
subsystem = 'ios'
kernel = 'xnu'
cpu_family = 'aarch64'
cpu = 'aarch64'
endian = 'little'
EOF

	# Build-machine tools (fribidi's table generator, ...) are macOS programs.
	local native=$work/$target/meson-native.ini
	printf "[binaries]\nc = ['clang']\ncpp = ['clang++']\nobjc = ['clang']\n" > "$native"

	meson_build() {
		local name=$1 dir stamp
		shift
		dir=$(srcdir "$name")
		stamp="$(version_of "$name") $*"
		[ "$(cat "$build/$name.done" 2>/dev/null)" = "$stamp" ] && return
		echo "--- [$target] $name"
		rm -rf "${build:?}/$name"
		meson setup "$build/$name" "$dir" --cross-file "$cross" --native-file "$native" --prefix "$prefix" --libdir lib \
			--buildtype release -Db_ndebug=true -Ddefault_library=static -Dauto_features=disabled \
			-Dwrap_mode=nodownload "$@" > "$build/$name.log" 2>&1 || { tail -50 "$build/$name.log"; exit 1; }
		meson install -C "$build/$name" >> "$build/$name.log" 2>&1 || { tail -50 "$build/$name.log"; exit 1; }
		echo "$stamp" > "$build/$name.done"
	}

	meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
	meson_build freetype -Derror_strings=false
	meson_build harfbuzz -Dfreetype=enabled -Dtests=disabled -Ddocs=disabled -Dutilities=disabled
	meson_build libass -Dcoretext=enabled -Dasm=enabled -Drequire-system-font-provider=true
	meson_build dav1d -Denable_tools=false -Denable_tests=false -Denable_examples=false -Denable_asm=true
	# OpenGL (ES) only, as on macOS; mpv's own renderer draws, libplacebo is a dependency.
	meson_build libplacebo -Dopengl=enabled -Dgl-proc-addr=enabled -Ddemos=false -Dtests=false

	# --- FFmpeg: same trim as build.sh -------------------------------------
	local ffmpeg_filters=abuffer,abuffersink,aformat,anull,aresample,buffer,buffersink,format,null,scale,
	ffmpeg_filters+=bwdif,yadif,hflip,vflip,transpose,crop,pad,volume,atempo,pan,loudnorm,dynaudnorm
	ffmpeg_filters+=,equalizer,bass,treble,dialoguenhance
	local ffmpeg_protocols=file,pipe,data,http,https,httpproxy,tcp,tls,crypto,hls,concat,subfile
	local ffmpeg_flags=(
		--prefix="$prefix"
		--enable-cross-compile --target-os=darwin --arch=arm64
		--cc="clang -target $triple" --cxx="clang++ -target $triple" --objcc="clang -target $triple"
		--extra-cflags="-isysroot $sdk" --extra-objcflags="-isysroot $sdk" --extra-ldflags="-isysroot $sdk"
		--sysroot="$sdk"
		--pkg-config=pkg-config --pkg-config-flags=--static
		--enable-static --disable-shared --enable-pic
		--disable-programs --disable-doc --disable-debug --disable-avdevice
		--disable-encoders --disable-muxers --disable-devices --disable-outdevs --disable-indevs
		--disable-filters --enable-filter="$ffmpeg_filters"
		--disable-protocols --enable-protocol="$ffmpeg_protocols"
		--disable-autodetect
		--enable-videotoolbox --enable-securetransport --enable-zlib --enable-iconv
		--enable-libdav1d
	)
	local ffmpeg_dir ffmpeg_stamp
	ffmpeg_dir=$(srcdir ffmpeg)
	ffmpeg_stamp="$(version_of ffmpeg) ${ffmpeg_flags[*]}"
	if [ "$(cat "$build/ffmpeg.done" 2>/dev/null)" != "$ffmpeg_stamp" ]; then
		echo "--- [$target] ffmpeg"
		rm -rf "$build/ffmpeg"
		mkdir -p "$build/ffmpeg"
		(
			cd "$build/ffmpeg"
			"$ffmpeg_dir/configure" "${ffmpeg_flags[@]}" > "$build/ffmpeg.log" 2>&1 || { tail -50 config.log; exit 1; }
			make -j"$jobs" >> "$build/ffmpeg.log" 2>&1 || { tail -50 "$build/ffmpeg.log"; exit 1; }
			make install >> "$build/ffmpeg.log" 2>&1
		)
		echo "$ffmpeg_stamp" > "$build/ffmpeg.done"
	fi
	grep -q 'License: LGPL version 2.1 or later' "$build/ffmpeg.log" ||
		{ echo "build-ios.sh: FFmpeg isn't configured LGPL 2.1 or later" >&2; exit 1; }

	# --- mpv ---------------------------------------------------------------
	# libmpv only. GLES through the render API (plain-gl + ios-gl), VideoToolbox
	# via its GLES texture-cache interop, AudioUnit output. No Cocoa/Swift.
	local mpv_flags=(
		-Dgpl=false -Dlibmpv=true -Dcplayer=false -Dtests=false -Dfuzzers=false -Dbuild-date=false
		-Ddefault_library=shared
		-Diconv=enabled -Dzlib=enabled -Dvector=enabled
		-Dcocoa=disabled -Dswift-build=disabled -Dgl-cocoa=disabled
		-Dgl=enabled -Dplain-gl=enabled -Dios-gl=enabled -Dvideotoolbox-gl=disabled
		-Daudiounit=enabled -Dcoreaudio=disabled
	)
	local mpv_dir
	mpv_dir=$(srcdir mpv)
	for p in "$here"/ios-patches/mpv-*.patch; do [ -f "$p" ] && patch_src "$mpv_dir" "$p"; done
	echo "--- [$target] mpv"
	rm -rf "$build/mpv"
	meson setup "$build/mpv" "$mpv_dir" --cross-file "$cross" --native-file "$native" --prefix "$prefix" --libdir lib \
		--buildtype release -Db_ndebug=true -Dauto_features=disabled -Dwrap_mode=nodownload \
		"${mpv_flags[@]}" > "$build/mpv.log" 2>&1 || { tail -80 "$build/mpv.log"; exit 1; }
	meson install -C "$build/mpv" >> "$build/mpv.log" 2>&1 || { tail -50 "$build/mpv.log"; exit 1; }

	# --- package: libmpv.framework (flat iOS layout) ------------------------
	local fw=$dist/libmpv.framework
	mkdir -p "$fw/Headers" "$dist/licences"
	local lib
	lib=$(cd "$prefix/lib" && ls libmpv.*.dylib | head -1)
	cp "$prefix/lib/$lib" "$fw/libmpv"
	cp -R "$prefix/include/mpv" "$fw/Headers/"
	install_name_tool -id "@rpath/libmpv.framework/libmpv" "$fw/libmpv"
	otool -l "$fw/libmpv" | awk '/LC_RPATH/ { f = 1 } f && / path / { print $2; f = 0 }' |
		while read -r p; do install_name_tool -delete_rpath "$p" "$fw/libmpv"; done
	strip -x "$fw/libmpv"
	local platform=iPhoneOS
	[ $sdkname = iphonesimulator ] && platform=iPhoneSimulator
	cat > "$fw/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>libmpv</string>
<key>CFBundleIdentifier</key><string>app.peli.libmpv</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>libmpv</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>$(version_of mpv)</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
<key>MinimumOSVersion</key><string>$ios_min</string>
</dict></plist>
EOF
	codesign --force --sign - "$fw"

	# Only the system's libraries and frameworks.
	local deps bad
	deps=$(otool -L "$fw/libmpv" | tail -n +2 | awk '{print $1}')
	if bad=$(grep -Ev '^(/usr/lib/|/System/Library/|@rpath/libmpv)' <<<"$deps"); then
		echo "build-ios.sh: libmpv links outside the system: $bad" >&2
		exit 1
	fi
	local mpv_features ffmpeg_config
	mpv_features=$(sed -n 's/^#define FULLCONFIG "\(.*\)"$/\1/p' "$build/mpv/config.h")
	if grep -qw gpl <<<"$mpv_features"; then echo "build-ios.sh: mpv was configured GPL" >&2; exit 1; fi
	ffmpeg_config=$(sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "$build/ffmpeg/config.h")
	{
		echo "Peli libmpv $target (ios-libmpv spike, ADR-0003)"
		echo "Licence: LGPL 2.1 or later (mpv -Dgpl=false; FFmpeg without GPL/version3/non-free options)."
		echo "Minimum iOS: $ios_min ($triple), SDK $sdkname $(xcrun --sdk $sdkname --show-sdk-version)"
		echo "mpv features: $mpv_features"
		echo "mpv meson options: ${mpv_flags[*]}"
		echo "FFmpeg configure: ${ffmpeg_config//$work/<work>}"
	} > "$dist/BUILD-INFO.txt"
	echo "built $fw ($(du -sk "$fw/libmpv" | cut -f1) KiB binary)"
}

start=$(date +%s)
for t in "${targets[@]}"; do
	s=$(date +%s)
	build_slice "$t"
	echo "[$t] $(($(date +%s) - s)) s"
done

if [ ${#targets[@]} -eq 2 ]; then
	rm -rf "$work/libmpv.xcframework"
	xcodebuild -create-xcframework \
		-framework "$work/libmpv-ios-arm64/libmpv.framework" \
		-framework "$work/libmpv-ios-sim-arm64/libmpv.framework" \
		-output "$work/libmpv.xcframework"
	du -sk "$work"/libmpv.xcframework/*/libmpv.framework/libmpv
fi
echo "total $(($(date +%s) - start)) s"
