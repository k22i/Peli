#!/usr/bin/env bash
# #92: builds our trimmed LGPL libmpv (ADR-0003) for one target from the
# pinned sources in sources.txt.
#
#   build/libmpv/build.sh <target> [work-dir]
#
# Targets: macos-arm64, macos-x86_64 (either builds on any Apple silicon or
# Intel Mac). Windows comes next; Linux is deferred (#103).
#
# The result is one shared library with every dependency linked in statically
# (FFmpeg, libplacebo, libass and its font stack, dav1d), so the app bundles
# a single file and users can still swap it for their own build:
#
#   <work>/libmpv-<target>/          include/mpv, lib/libmpv.2.dylib,
#                                    lib/pkgconfig/mpv.pc, BUILD-INFO.txt,
#                                    licences/
#   <work>/libmpv-<target>.tar.xz    the same, for publishing
#
# Needs: clang (Xcode Command Line Tools), meson ≥ 1.3, ninja, nasm (x86_64
# only), git, curl, pkg-config and python3.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
target=${1:?usage: build.sh <target> [work-dir]}
work=${2:-$here/.work}
mkdir -p "$work"
work=$(cd "$work" && pwd)

case $target in
macos-arm64) arch=arm64 ;;
macos-x86_64) arch=x86_64 ;;
*) echo "build.sh: unknown target $target" >&2; exit 2 ;;
esac

# Sinag's own minimum (build/darwin/Taskfile.yml).
macos_min=12.0
jobs=$(sysctl -n hw.ncpu 2>/dev/null || nproc)

dl=$work/downloads
src=$work/src
build=$work/$target/build
prefix=$work/$target/prefix
dist=$work/libmpv-$target
# A component is rebuilt only when its version or options change (stamps in
# the build directory); CI always starts from an empty work directory.
rm -rf "$dist" "$dist.tar.xz"
mkdir -p "$dl" "$src" "$build" "$prefix/lib/pkgconfig"

# Only our own prefix: a Homebrew or system library must never be picked up.
export PKG_CONFIG_LIBDIR=$prefix/lib/pkgconfig
unset PKG_CONFIG_PATH CPATH C_INCLUDE_PATH LIBRARY_PATH

# --- sources ----------------------------------------------------------------

# srcdir <name>: where sources.txt's <name> is unpacked, fetching and checking
# it first.
srcdir() {
	local name=$1 version url sum
	read -r version url sum < <(awk -v n="$name" '$1 == n { print $2, $3, $4 }' "$here/sources.txt")
	[ -n "$sum" ] || { echo "build.sh: $name not in sources.txt" >&2; exit 1; }
	local dir=$src/$name-$version
	if [ ! -d "$dir" ]; then
		if [[ $url == git+* ]]; then
			rm -rf "$dir.tmp"
			git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" \
				--recurse-submodules --shallow-submodules "${url#git+}" "$dir.tmp"
			local head
			head=$(git -C "$dir.tmp" rev-parse HEAD)
			[ "$head" = "$sum" ] || { echo "build.sh: $name $version is at $head, pinned $sum" >&2; exit 1; }
		else
			local file=$dl/${url##*/}
			if [ ! -f "$file" ]; then
				curl -fsSL --retry 3 -o "$file.tmp" "$url"
				mv "$file.tmp" "$file"
			fi
			local got
			got=$(shasum -a 256 "$file" | cut -d' ' -f1)
			[ "$got" = "$sum" ] || { echo "build.sh: $file has SHA-256 $got, pinned $sum" >&2; rm -f "$file"; exit 1; }
			rm -rf "$dir.tmp" && mkdir -p "$dir.tmp"
			tar -xf "$file" -C "$dir.tmp" --strip-components 1
		fi
		mv "$dir.tmp" "$dir"
	fi
	echo "$dir"
}

version_of() { awk -v n="$1" '$1 == n { print $2 }' "$here/sources.txt"; }

# --- toolchain --------------------------------------------------------------

sdk=$(xcrun --sdk macosx --show-sdk-path)
host_cpu=$([ "$arch" = arm64 ] && echo aarch64 || echo x86_64)
cflags="-arch $arch -mmacosx-version-min=$macos_min -isysroot $sdk"
export MACOSX_DEPLOYMENT_TARGET=$macos_min

# A cross file even for a native build: it pins the architecture and keeps
# meson from probing the host.
cross=$work/$target/meson-cross.ini
cat > "$cross" <<EOF
[binaries]
c = ['clang', '-arch', '$arch']
cpp = ['clang++', '-arch', '$arch']
objc = ['clang', '-arch', '$arch']
ar = 'ar'
strip = 'strip'
# --static: FFmpeg and the rest are static, so mpv needs their private libs.
pkg-config = ['pkg-config', '--static']
nasm = 'nasm'

[built-in options]
c_args = [$(printf "'%s', " $cflags)]
cpp_args = [$(printf "'%s', " $cflags)]
objc_args = [$(printf "'%s', " $cflags)]
c_link_args = [$(printf "'%s', " $cflags)]
cpp_link_args = [$(printf "'%s', " $cflags)]
objc_link_args = [$(printf "'%s', " $cflags)]

[properties]
needs_exe_wrapper = true

[host_machine]
system = 'darwin'
subsystem = 'macos'
kernel = 'xnu'
cpu_family = '$host_cpu'
cpu = '$host_cpu'
endian = 'little'
EOF

# meson_build <name> <options…>: a static, release build of <name> into the
# prefix, with every auto feature off unless named.
meson_build() {
	local name=$1 dir stamp
	shift
	dir=$(srcdir "$name")
	stamp="$(version_of "$name") $*"
	[ "$(cat "$build/$name.done" 2>/dev/null)" = "$stamp" ] && return
	echo "--- $name"
	rm -rf "${build:?}/$name"
	meson setup "$build/$name" "$dir" --cross-file "$cross" --prefix "$prefix" --libdir lib \
		--buildtype release -Db_ndebug=true -Ddefault_library=static -Dauto_features=disabled \
		-Dwrap_mode=nodownload "$@" > "$build/$name.log" 2>&1 || { tail -50 "$build/$name.log"; exit 1; }
	meson install -C "$build/$name" >> "$build/$name.log" 2>&1 || { tail -50 "$build/$name.log"; exit 1; }
	echo "$stamp" > "$build/$name.done"
}

# --- dependencies -----------------------------------------------------------

meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
meson_build freetype -Derror_strings=false
meson_build harfbuzz -Dfreetype=enabled -Dtests=disabled -Ddocs=disabled -Dutilities=disabled
meson_build libass -Dcoretext=enabled -Dasm=enabled -Drequire-system-font-provider=true
meson_build dav1d -Denable_tools=false -Denable_tests=false -Denable_examples=false -Denable_asm=true
# OpenGL only: the render API (#60) draws with it. No Vulkan, so no shader
# compiler either.
meson_build libplacebo -Dopengl=enabled -Dgl-proc-addr=enabled -Ddemos=false -Dtests=false

# --- FFmpeg -----------------------------------------------------------------

# Decoders, demuxers and parsers stay whole: they're what plays, and a format
# we left out would fail on someone's file. What goes is everything that
# doesn't play: encoders, muxers, devices, programs, and the filters and
# protocols mpv doesn't use. No --enable-gpl, --enable-version3 or
# --enable-nonfree: LGPL 2.1 or later.
ffmpeg_filters=abuffer,abuffersink,aformat,anull,aresample,buffer,buffersink,format,null,scale,
ffmpeg_filters+=bwdif,yadif,hflip,vflip,transpose,crop,pad,volume,atempo,pan,loudnorm,dynaudnorm
# The player's sound (internal/player/sound.go): an equalizer (all three in
# af_biquads.c) and dialogue boost. LGPL, none needs --enable-gpl.
ffmpeg_filters+=,equalizer,bass,treble,dialoguenhance
ffmpeg_protocols=file,pipe,data,http,https,httpproxy,tcp,tls,crypto,hls,concat,subfile

ffmpeg_flags=(
	--prefix="$prefix"
	--enable-cross-compile --target-os=darwin --arch="$arch"
	--cc=clang --cxx=clang++ --objcc=clang
	--extra-cflags="$cflags" --extra-objcflags="$cflags" --extra-ldflags="$cflags"
	--pkg-config=pkg-config --pkg-config-flags=--static
	--enable-static --disable-shared --enable-pic
	--disable-programs --disable-doc --disable-debug --disable-avdevice
	--disable-encoders --disable-muxers --disable-devices --disable-outdevs --disable-indevs
	--disable-filters --enable-filter="$ffmpeg_filters"
	--disable-protocols --enable-protocol="$ffmpeg_protocols"
	# Nothing found by accident: only what is named here.
	--disable-autodetect
	--enable-videotoolbox --enable-securetransport --enable-zlib --enable-iconv
	--enable-libdav1d
)
ffmpeg_dir=$(srcdir ffmpeg)
ffmpeg_stamp="$(version_of ffmpeg) ${ffmpeg_flags[*]}"
if [ "$(cat "$build/ffmpeg.done" 2>/dev/null)" != "$ffmpeg_stamp" ]; then
	echo "--- ffmpeg"
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
	{ echo "build.sh: FFmpeg isn't configured LGPL 2.1 or later" >&2; grep -i license "$build/ffmpeg.log" >&2; exit 1; }

# --- mpv --------------------------------------------------------------------

# The libmpv client and render API (OpenGL, through the Cocoa GL backend that
# VideoToolbox's GL interop needs). Cocoa needs mpv's Swift parts to compile
# (0.41 doesn't build Cocoa without them); the Swift runtime is part of macOS
# 12. No player, Lua, JavaScript, VapourSynth, Vulkan or anything else not
# named.
mpv_flags=(
	-Dgpl=false -Dlibmpv=true -Dcplayer=false -Dtests=false -Dfuzzers=false -Dbuild-date=false
	-Ddefault_library=shared
	-Diconv=enabled -Dzlib=enabled -Dvector=enabled
	-Dcocoa=enabled -Dswift-build=enabled -Dswift-flags="-target $arch-apple-macos$macos_min"
	-Dgl=enabled -Dgl-cocoa=enabled -Dvideotoolbox-gl=enabled -Dcoreaudio=enabled
	-Dmacos-10-15-4-features=enabled -Dmacos-11-features=enabled -Dmacos-11-3-features=enabled
	-Dmacos-12-features=enabled
)
mpv_dir=$(srcdir mpv)
echo "--- mpv"
rm -rf "$build/mpv"
meson setup "$build/mpv" "$mpv_dir" --cross-file "$cross" --prefix "$prefix" --libdir lib \
	--buildtype release -Db_ndebug=true -Dauto_features=disabled -Dwrap_mode=nodownload \
	"${mpv_flags[@]}" > "$build/mpv.log" 2>&1 || { tail -80 "$build/mpv.log"; exit 1; }
meson install -C "$build/mpv" >> "$build/mpv.log" 2>&1 || { tail -50 "$build/mpv.log"; exit 1; }

# --- package ----------------------------------------------------------------

mkdir -p "$dist/lib/pkgconfig" "$dist/include" "$dist/licences"
cp -R "$prefix/include/mpv" "$dist/include/"
lib=$(cd "$prefix/lib" && ls libmpv.*.dylib | head -1)
cp "$prefix/lib/$lib" "$dist/lib/"
ln -s "$lib" "$dist/lib/libmpv.dylib"
# Relocatable: the app finds it through its own rpath (@executable_path/../Frameworks).
install_name_tool -id "@rpath/$lib" "$dist/lib/$lib"
# Swift's link adds an rpath to the toolchain that built it.
otool -l "$dist/lib/$lib" | awk '/LC_RPATH/ { f = 1 } f && / path / { print $2; f = 0 }' |
	while read -r p; do install_name_tool -delete_rpath "$p" "$dist/lib/$lib"; done
strip -x "$dist/lib/$lib"
codesign --force --sign - "$dist/lib/$lib"

# A pkg-config file that works wherever the directory is unpacked.
mpv_version=$(sed -n 's/^Version: //p' "$prefix/lib/pkgconfig/mpv.pc")
cat > "$dist/lib/pkgconfig/mpv.pc" <<EOF
prefix=\${pcfiledir}/../..
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: mpv
Description: mpv media player client library (Sinag's LGPL build, #92)
Version: $mpv_version
Libs: -L\${libdir} -lmpv -Wl,-rpath,\${libdir}
Cflags: -I\${includedir}
EOF

# The library must load on any Mac at our minimum: only the system's own
# libraries and frameworks, and nothing built for a newer macOS.
deps=$(otool -L "$dist/lib/$lib" | tail -n +2 | awk '{print $1}')
if bad=$(grep -Ev '^(/usr/lib/|/System/Library/|@rpath/libmpv)' <<<"$deps"); then
	echo "build.sh: $lib links outside the system: $bad" >&2
	exit 1
fi
minos=$(otool -l "$dist/lib/$lib" | awk '/LC_BUILD_VERSION/ { f = 1 } f && /minos/ { print $2; exit }')
[ "$minos" = "$macos_min" ] || { echo "build.sh: $lib has minos $minos, want $macos_min" >&2; exit 1; }
lipo -archs "$dist/lib/$lib" | grep -qx "$arch" || { echo "build.sh: $lib isn't $arch only" >&2; exit 1; }

# Licences, for THIRD_PARTY_NOTICES (#18) and anyone rebuilding it. Only the
# texts that apply to this build: FFmpeg's and mpv's GPL ones don't.
licences=(
	"mpv Copyright LICENSE.LGPL"
	"ffmpeg COPYING.LGPLv2.1"
	"libplacebo LICENSE"
	"libass COPYING"
	"freetype LICENSE.TXT docs/FTL.TXT"
	"harfbuzz COPYING"
	"fribidi COPYING"
	"dav1d COPYING"
)
for entry in "${licences[@]}"; do
	read -r name files <<<"$entry"
	dir=$(srcdir "$name")
	mkdir -p "$dist/licences/$name"
	for f in $files; do cp "$dir/$f" "$dist/licences/$name/"; done
done

# What was built and how: #18's audit can't see mpv's own -Dgpl=false, so it
# is recorded here, with FFmpeg's configuration as FFmpeg reports it. The
# audit scans this file too, so it never spells out FFmpeg's GPL options.
mpv_features=$(sed -n 's/^#define FULLCONFIG "\(.*\)"$/\1/p' "$build/mpv/config.h")
if grep -qw gpl <<<"$mpv_features"; then
	echo "build.sh: mpv was configured GPL: $mpv_features" >&2
	exit 1
fi
ffmpeg_config=$(sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "$build/ffmpeg/config.h")
unpacked=$(du -sk "$dist/lib/$lib" | cut -f1)
{
	echo "Sinag libmpv $target (#92, ADR-0003)"
	echo
	echo "Sources:"
	awk '!/^#/ && NF { printf "  %-11s %-10s %s %s\n", $1, $2, $3, $4 }' "$here/sources.txt"
	echo
	echo "Licence: LGPL 2.1 or later. mpv is built with -Dgpl=false; FFmpeg without its GPL, version 3 or non-free options."
	echo "Minimum macOS: $macos_min ($arch)"
	echo "Compiler: $(clang --version | head -1), macOS SDK $(xcrun --sdk macosx --show-sdk-version)"
	echo "Size: $lib $unpacked KiB unpacked"
	echo
	echo "mpv features: $mpv_features"
	echo "mpv meson options: ${mpv_flags[*]}"
	echo
	echo "FFmpeg configure: ${ffmpeg_config//$work/<work>}"
} > "$dist/BUILD-INFO.txt"

tar -C "$work" -cJf "$dist.tar.xz" "libmpv-$target"
(cd "$work" && shasum -a 256 "libmpv-$target.tar.xz" > "libmpv-$target.tar.xz.sha256")

packed=$(du -sk "$dist.tar.xz" | cut -f1)
echo "built $dist ($lib $unpacked KiB, tar.xz $packed KiB)"
