---
status: accepted
date: 2026-10-31
---

# Our libmpv build: one self-contained library per target, every decoder kept, built and cached in CI

ADR-0003 decided that every package bundling libmpv ships our own LGPL build. #92 builds it. `build/libmpv/` has the pinned sources, the build script and a smoke test (its README says how to build, use, bump and publish it).

## One library, dependencies static

Each target is a single `libmpv.2.dylib` with FFmpeg, libplacebo, libass, FreeType, HarfBuzz, FriBidi and dav1d linked in statically. It links nothing but the system's own libraries. One file is simpler to bundle, sign and swap than the 18 dylibs of media-kit's build, and the LGPL is still met: the whole library is LGPL, dynamically linked, and a user can replace it with their own build. The macOS bundle carries it in `Contents/Frameworks` with install name `@rpath/libmpv.2.dylib`. `wails3 package` copies it there and sets the binary's rpath.

## Trimmed by what doesn't play, not by format

FFmpeg keeps **every decoder, demuxer and parser**. A list of formats we expect would fail on someone's file, and keeping them all is cheap: the arm64 library is 21.2 MB unpacked and 8.5 MiB compressed, against 15 MB per platform in #92 and 60 MB per installer in ADR-0005. What goes is everything that doesn't play: encoders, muxers, devices, programs, and the filters and protocols mpv doesn't use. TrueHD, DTS(-HD), E-AC-3 and Atmos-carrying streams decode, and passthrough is mpv's.

mpv keeps the libmpv client and render API and nothing it doesn't need: no player, Lua, JavaScript, VapourSynth, Vulkan, uchardet, lcms2, libarchive, Blu-ray or DVD. On macOS that means Cocoa, OpenGL (the render API, ADR-0039) and VideoToolbox's GL interop. mpv 0.41 doesn't compile Cocoa without its Swift parts, so they're in. The Swift runtime is part of macOS 12, our minimum.

No Vulkan means no shader compiler (shaderc or glslang) in the macOS build. Windows needs one for D3D11 (`vo=gpu-next` with `wid`, ADR-0039), so its build will be bigger.

## Built in CI, cached, published on demand

`libmpv.yml` builds each target on its own architecture (macos-15, macos-15-intel), runs the smoke test and caches the result by the hash of `build/libmpv/`. `ci.yml` calls it on every run, so a CI run rebuilds libmpv only when a pin or the script changes (about 3 minutes on an M1 Pro, longer on runners), and its macOS jobs build and package against the result. Run by hand with `publish`, it puts each build, `SHA256SUMS` and the exact sources on a release, which packaging (#88) fetches. Nothing downloads a third-party libmpv for macOS any more.

The alternative was publishing once and having CI fetch a pinned release. That needs a release to exist before the first CI run after a pin change, and a second commit for its checksums. The cache gives the same pinning, since the sources are checksummed, with one commit.

## Licence checks

`build.sh` fails unless FFmpeg reports "LGPL version 2.1 or later" and mpv's feature list has no `gpl`. It writes both configurations to `BUILD-INFO.txt`, because #18's audit can't see mpv's `-Dgpl=false` in the binary. `ci.yml`'s build job audits the app bundle with the library in it. The notices take each library's version from `sources.txt` and its licence text from `third_party/licences/`.

## Consequences

- Subtitles in a legacy code page aren't detected without uchardet; mpv falls back to UTF-8. Add it if addon subtitles in Windows-1252 and the like turn up garbled.
- No ICC profiles (lcms2): the render API gets none from the macOS host today anyway.
- `osc`, `ytdl` and `load-scripts` don't exist in this build. The player sets them to `no` and skips options a build lacks, so it only logs a warning.
- Go's build cache doesn't notice a different `PKG_CONFIG_PATH`: switching a checkout between Homebrew's mpv and this build needs `go clean -cache`.
- The x86_64 build is cross-compiled and smoke-tested only in CI: the dev Mac has no Rosetta.
