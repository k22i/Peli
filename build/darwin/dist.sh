#!/bin/sh
# Peli's macOS distribution steps (#78, ADR-0053). The Taskfile calls these;
# run `wails3 task darwin:release ARCH=arm64` (or amd64) for the whole thing.
#
#   dist.sh sign <Peli.app>              sign the libraries, then the app, with
#                                        the hardened runtime
#   dist.sh dmg <Peli.app> <arch>        build bin/Peli-<version>-<arch>.dmg:
#                                        the drag-to-Applications window,
#                                        ULMO-compressed, signed, ≤ 60 MB
#   dist.sh notarize <Peli.app|.dmg>     submit to Apple, wait, staple, check
#   dist.sh check <Peli.app> <arch>      what a shipped bundle must be
#   dist.sh zip <Peli.app> <arch>        build bin/Peli-<version>-<arch>.zip,
#                                        what installed copies update from
#                                        (#83, ADR-0054)
#
# Signing identity: PELI_SIGN_IDENTITY, a "Developer ID Application: … (TEAM)"
# certificate in the keychain (its name or SHA-1). Unset or "-" signs ad hoc,
# which runs on this Mac but not on anyone else's, and needs
# entitlements.adhoc.plist's one exception to load libmpv.
#
# Notarization credentials, one of:
#   PELI_NOTARY_PROFILE   a profile saved with `xcrun notarytool store-credentials`
#   PELI_NOTARY_KEY, PELI_NOTARY_KEY_ID, PELI_NOTARY_ISSUER
#                         an App Store Connect API key (.p8 path, key ID, issuer
#                         ID), for CI
set -eu

here=$(cd "$(dirname "$0")" && pwd)
identity=${PELI_SIGN_IDENTITY:--}
limit=60000000 # bytes per DMG, per architecture (ADR-0005)

die() {
	echo "dist.sh: $*" >&2
	exit 1
}

version() {
	/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist"
}

# lipo's names: amd64 builds are x86_64.
machine() {
	case $1 in
	arm64) echo arm64 ;;
	amd64 | x86_64) echo x86_64 ;;
	*) die "unknown architecture $1" ;;
	esac
}

sign() {
	app=$1
	set -- --force --options runtime
	entitlements=$here/entitlements.plist
	if [ "$identity" = - ]; then
		entitlements=$here/entitlements.adhoc.plist
	else
		set -- "$@" --timestamp
	fi
	xattr -cr "$app"
	# Inside out: codesign --deep would sign nested code without the runtime
	# flag or a timestamp, and notarization rejects both.
	for lib in "$app"/Contents/Frameworks/*.dylib; do
		[ -e "$lib" ] || continue
		codesign "$@" --sign "$identity" "$lib"
	done
	codesign "$@" --entitlements "$entitlements" --sign "$identity" "$app"
	codesign --verify --deep --strict --verbose=2 "$app"
}

check() {
	app=$1
	arch=$(machine "$2")
	exe=$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
	lib=$app/Contents/Frameworks/libmpv.2.dylib

	[ "$(lipo -archs "$exe")" = "$arch" ] || die "$exe is $(lipo -archs "$exe"), not $arch"
	[ -f "$lib" ] || die "no libmpv in $app (#92)"
	[ "$(lipo -archs "$lib")" = "$arch" ] || die "$lib is $(lipo -archs "$lib"), not $arch"
	otool -L "$exe" | grep -q '@rpath/libmpv.2.dylib' ||
		die "$exe doesn't link Peli's own libmpv (ADR-0003): build with PKG_CONFIG_PATH at build/libmpv's output"
	# A stale rpath to a build directory (Go's cache ignores PKG_CONFIG_PATH)
	# would make the app look for libraries on the user's disk.
	rpaths=$(otool -l "$exe" | awk '/LC_RPATH/ { f = 1 } f && / path / { print $2; f = 0 }')
	[ "$rpaths" = "@executable_path/../Frameworks" ] ||
		die "$exe has rpaths $(echo "$rpaths" | tr '\n' ' ')- clear Go's build cache and rebuild"
	# Only the system's libraries besides our own.
	others=$(otool -L "$exe" "$lib" | awk 'NR > 1 && /^\t/ { print $1 }' |
		grep -v -e '^/usr/lib/' -e '^/System/Library/' -e '^@rpath/libmpv.2.dylib$' || true)
	[ -z "$others" ] || die "links libraries a Mac doesn't have: $others"
	codesign --verify --deep --strict "$app"
	codesign -d --verbose=2 "$app" 2>&1 | grep -q 'flags=.*runtime' || die "$app isn't signed with the hardened runtime"
	if [ "$identity" != - ] && codesign -d --entitlements - "$app" 2>/dev/null | grep -q disable-library-validation; then
		die "$app carries the ad-hoc entitlements: sign it again with PELI_SIGN_IDENTITY set"
	fi
	echo "$app: $arch, own libmpv, hardened runtime"
}

dmg() {
	app=$1
	arch=$(machine "$2")
	out=$(dirname "$app")
	name=$(basename "$app" .app)
	file=$out/$name-$(version "$app")-$arch.dmg

	# Wails lays out the window (Peli on the left, an Applications link on
	# the right, the background) in a UDZO image named after the app. ULMO
	# (LZMA, macOS 10.15+) makes it about 30 % smaller.
	wails3 tool package --format dmg --name "$name" --out "$out" \
		--background "$here/dmg-background.tiff" \
		--volume-icon "$here/icons.icns" \
		--window-width 540 --window-height 380
	rm -f "$file"
	hdiutil convert "$out/$name.dmg" -format ULMO -o "$file" -quiet
	rm -f "$out/$name.dmg"
	[ "$identity" = - ] || codesign --force --timestamp --sign "$identity" "$file"

	size=$(stat -f %z "$file")
	echo "$file: $size bytes (limit $limit)"
	[ "$size" -le "$limit" ] || die "$file is over the $limit-byte limit (ADR-0005)"
}

# The update: the same (stapled) app, zipped with Peli.app as its one
# top-level entry, which is what Wails' updater unpacks. Resource forks and
# extended attributes stay out: the signature doesn't use them, and xattr -cr
# cleared them before signing anyway.
zip() {
	app=$1
	arch=$(machine "$2")
	file=$(dirname "$app")/$(basename "$app" .app)-$(version "$app")-$arch.zip
	rm -f "$file"
	ditto -c -k --norsrc --noextattr --noqtn --keepParent "$app" "$file"
	echo "$file: $(stat -f %z "$file") bytes"
}

notarize() {
	file=$1
	[ "$identity" != - ] || die "set PELI_SIGN_IDENTITY: Apple doesn't notarize ad-hoc signatures"
	if [ -n "${PELI_NOTARY_PROFILE:-}" ]; then
		set -- --keychain-profile "$PELI_NOTARY_PROFILE"
	elif [ -n "${PELI_NOTARY_KEY:-}" ]; then
		set -- --key "$PELI_NOTARY_KEY" --key-id "${PELI_NOTARY_KEY_ID:?}" --issuer "${PELI_NOTARY_ISSUER:?}"
	else
		die "set PELI_NOTARY_PROFILE, or PELI_NOTARY_KEY, PELI_NOTARY_KEY_ID and PELI_NOTARY_ISSUER"
	fi

	upload=$file
	case $file in
	*.app)
		# An app goes up as a zip; the ticket is stapled to the app itself.
		upload=$(mktemp -d)/$(basename "$file").zip
		ditto -c -k --keepParent "$file" "$upload"
		;;
	esac
	result=$(xcrun notarytool submit "$upload" --wait --output-format plist "$@")
	id=$(echo "$result" | plutil -extract id raw -)
	status=$(echo "$result" | plutil -extract status raw -)
	if [ "$status" != Accepted ]; then
		xcrun notarytool log "$id" "$@" >&2 || true
		die "notarization of $file: $status (submission $id)"
	fi
	[ "$upload" = "$file" ] || rm -rf "$(dirname "$upload")"

	xcrun stapler staple "$file"
	xcrun stapler validate "$file"
	case $file in
	*.app) spctl --assess --type execute --verbose=2 "$file" ;;
	*) spctl --assess --type open --context context:primary-signature --verbose=2 "$file" ;;
	esac
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case $cmd in
sign) sign "${1:?usage: dist.sh sign <app>}" ;;
check) check "${1:?usage: dist.sh check <app> <arch>}" "${2:?usage: dist.sh check <app> <arch>}" ;;
dmg) dmg "${1:?usage: dist.sh dmg <app> <arch>}" "${2:?usage: dist.sh dmg <app> <arch>}" ;;
notarize) notarize "${1:?usage: dist.sh notarize <app|dmg>}" ;;
zip) zip "${1:?usage: dist.sh zip <app> <arch>}" "${2:?usage: dist.sh zip <app> <arch>}" ;;
*) die "usage: dist.sh sign|check|dmg|notarize|zip …" ;;
esac
