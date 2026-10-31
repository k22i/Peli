---
name: libmpv-build
description: "#92 our LGPL libmpv: build/libmpv (sources.txt pins, build.sh, smoke.sh), one static-deps dylib in Contents/Frameworks, libmpv.yml cached in CI; Go cache + pkg-config gotcha, local toolchain, no Rosetta"
metadata:
  type: project
---

#92 (ADR-0041): `build/libmpv/build.sh macos-arm64|macos-x86_64 [work]` builds one `libmpv.2.dylib` into `.work/libmpv-<target>/` (git-ignored). It's mpv 0.41 with `-Dgpl=false`, Swift parts on and OpenGL only, with FFmpeg 9.0.2, libplacebo, libass, FreeType, HarfBuzz, FriBidi and dav1d all linked statically. `smoke.sh <dir>` renders the player's fixtures through the render API. `wails3 package` copies the dylib to `Contents/Frameworks` and sets the rpath (the `bundle:libmpv` task). It only warns if the binary links Homebrew's libmpv. In CI, `ci.yml` calls `libmpv.yml`, which is cached by the hash of `build/libmpv/`, and the macOS go and build jobs get `PKG_CONFIG_PATH` from its artifact. The notices take versions from `sources.txt` and licence texts from `third_party/licences/`.

**Why:** ADR-0003 makes this the only libmpv any package may ship. Windows is the next lane (CI still links shinchiro's). Linux is deferred ([[platform-priority]]).

**How to apply:**
- Local toolchain: meson and ninja in a scratchpad venv (`pip install meson ninja`), `brew install nasm`. Pass a work dir in the scratchpad. A rerun rebuilds only the components whose version or flags changed (`*.done` stamps).
- **Go's build cache ignores `PKG_CONFIG_PATH`.** After switching between Homebrew's mpv and ours, a `-trimpath` build kept linking Homebrew's. Use a scratch `GOCACHE` (or `go clean -cache`) and check `otool -L` for `@rpath/libmpv.2.dylib`.
- This Mac has no Rosetta, so the x86_64 build can only be smoke-tested on CI's macos-15-intel.
- `BUILD-INFO.txt` and anything that ends up in the app must never contain FFmpeg's GPL flag strings or "GPL version N or later", because `tools/notices -audit -bundle` flags them. That's why FFmpeg's LICENSE.md isn't copied.
- Our build has no `osc`, `ytdl` or `load-scripts` options (no Lua). The player just logs that it skipped them.
- Related: [[player-service]], [[hardware-decoding-hdr]].
