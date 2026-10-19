---
status: accepted
date: 2026-10-12
---

# The app stays MIT; we build and bundle our own LGPL libmpv

Linking libmpv in-process (ADR-0001) means the libmpv we ship decides our licence. Both builds the spikes used are GPL: shinchiro's on Windows and Debian's / Homebrew's. Bundling one would make every release a GPL combined work. Instead, Cove stays **MIT**. Every package that contains libmpv ships **our own build, configured LGPL** (`-Dgpl=false`, FFmpeg without `--enable-gpl` / `--enable-nonfree`), dynamically linked so users can swap it. Distro packages (`.deb`) depend on the distro's `libmpv2` and bundle nothing.

We control that build, so we also trim it to what playback needs: no encoders, Lua, JavaScript or VapourSynth. That fixes the size and dependency problems the spikes found:

- **Size.** A full libmpv is 64–121 MB unpacked, while a trimmed LGPL build is 20–30 MB. Installers then land at roughly 15 MB on Windows and 8–19 MB on macOS ([#7](../spikes/baselines.md)).
- **Windows `vulkan-1.dll`.** Shinchiro's and zhongfly's builds import `vulkan-1.dll` directly, so the app would fail to start on a PC without the Vulkan loader. Our build must not import it directly.
- **macOS relocatability.** Homebrew's dylibs have absolute paths and target only the macOS they were built on. Ours must be relocatable and built for our minimum macOS, per architecture.
- **Pinning.** Shinchiro's daily builds are pruned. Ours are versioned, built in CI, and stored where releases can fetch them.

Not legal advice. This matches #18's plan; the spikes only confirmed it's needed.

## Consequences

- A new piece of infrastructure: per-platform libmpv builds (#92), needed early in M1 because #60 and CI depend on them.
- Some features in GPL-only code are gone, and #92 has to confirm none of them matter for playback. In particular, `wid` on Windows, the OpenGL render API, hardware decoding (d3d11va, videotoolbox, vaapi) and libplacebo's HDR tone-mapping must all still work in the LGPL build.
- #18's release audit checks every bundled binary's configuration, not just our own dependencies.
- If a feature we need turns out to be GPL-only, the choice is between dropping the feature and relicensing to GPL-3. That would take a new ADR.
