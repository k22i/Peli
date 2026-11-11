# Peli's libmpv

Our own LGPL build of libmpv ([ADR-0003](../../docs/adr/0003-mit-app-with-our-own-lgpl-libmpv.md), [ADR-0041](../../docs/adr/0041-our-libmpv-build.md), #92). Every package that bundles libmpv ships this one, never a third-party build.

| File | |
|---|---|
| `sources.txt` | The pinned sources: version, URL and SHA-256 (or a git commit) for mpv, FFmpeg and each library built into it |
| `build.sh` | Builds one target into `.work/libmpv-<target>/` and `.work/libmpv-<target>.tar.xz` |
| `smoke.sh`, `smoke/smoke_darwin.c` | Checks a build has the decoders and protocols Peli needs, and renders the player's fixtures through the OpenGL render API |
| `../../.github/workflows/libmpv.yml` | Builds, smoke-tests and caches each target for CI; publishes a release on demand |

Targets: `macos-arm64` and `macos-x86_64`, minimum macOS 12. Windows is next; Linux is deferred (#103), and the `.deb` uses the distribution's libmpv2.

## Build one

```sh
brew install nasm                       # x86_64 only; meson and ninja from pip or Homebrew
build/libmpv/build.sh macos-arm64       # about 3 minutes on an M1 Pro; reruns rebuild only what changed
build/libmpv/smoke.sh build/libmpv/.work/libmpv-macos-arm64
```

Either Mac architecture builds both targets. The smoke test runs only on the architecture it was built for.

## Use it

`lib/pkgconfig/mpv.pc` works wherever the directory is unpacked, and gives the binary an rpath to it:

```sh
export PKG_CONFIG_PATH=$PWD/build/libmpv/.work/libmpv-macos-arm64/lib/pkgconfig
go clean -cache   # Go's build cache doesn't notice a different pkg-config result
wails3 package    # copies libmpv.2.dylib into Peli.app/Contents/Frameworks
```

`wails3 package` copies the library into the bundle and points the binary's rpath at `Contents/Frameworks`. Built against Homebrew's mpv instead, the app still runs locally, but the package step warns that the bundle can't ship. CI builds every macOS job against this build (`ci.yml` calls `libmpv.yml`, which rebuilds only when something under `build/libmpv` changes).

## Bump a pin

Change the version, URL and checksum in `sources.txt` together (`shasum -a 256` of the download, or the commit a git tag points to). Then build and smoke-test both targets, run `go run ./tools/notices` (versions in the notices come from `sources.txt`), and check `BUILD-INFO.txt` still reports LGPL. If a library's licence text changed, update its copy in `third_party/licences/`.

## Publish

Run the `libmpv` workflow by hand with `publish` and a tag such as `libmpv-0.41.0-1`. The release gets each target's `.tar.xz`, `SHA256SUMS` and the exact sources it was built from (the LGPL's source offer). Packaging (#88) fetches from there.

## What's in it

One `libmpv.2.dylib` with every dependency linked in statically, so the app bundles a single file and users can swap it for their own build. It links only the system's libraries and frameworks (`build.sh` checks this, along with the minimum macOS and the architecture).

- **mpv**: the libmpv client and render API only, `-Dgpl=false`. Cocoa, OpenGL, VideoToolbox's GL interop, CoreAudio, iconv and zlib. mpv's Swift parts are included because 0.41 doesn't build Cocoa without them. No Lua, JavaScript, VapourSynth, Vulkan, uchardet, lcms2, libarchive, Blu-ray or DVD.
- **FFmpeg**: LGPL 2.1 or later. Every decoder, demuxer, parser and bitstream filter. No encoders, muxers, devices or programs, and only the filters and protocols mpv uses (HTTPS through Secure Transport). VideoToolbox and dav1d.
- **libplacebo** (OpenGL only), **libass** (Core Text fonts), **FreeType**, **HarfBuzz**, **FriBidi**, **dav1d**.

`BUILD-INFO.txt` in each build records the sources, mpv's features, its meson options and FFmpeg's configure line, because #18's audit can't see mpv's `-Dgpl=false` in the binary. It never names FFmpeg's GPL options: the audit would flag them.
