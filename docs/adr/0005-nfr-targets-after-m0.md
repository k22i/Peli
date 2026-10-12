---
status: accepted
date: 2026-10-12
---

# Non-functional targets after M0

[#7](../spikes/baselines.md) measured an empty Wails shell with libmpv, packaged the way v1 ships. Two targets can't be met as written: an AppImage under 60 MB, and a 2 s cold start on a Windows PC's first launch after install. Both are fixed costs of the platform (bundled WebKitGTK, WebView2 creating its profile), not of our code. So we restate those two targets and leave the rest:

| Target | Before | After | Why |
|---|---|---|---|
| Installer size | ≤ 60 MB per platform, including libmpv | **≤ 60 MB per installer, per architecture** (Windows NSIS, macOS DMG per arch, Flatpak download of our app on its runtime). **AppImage: ≤ 100 MB.** `.deb` has no bundled libmpv. | WebKitGTK, JavaScriptCore and ICU alone are ~70 MB compressed in an AppImage. A trimmed libmpv (ADR-0003) brings it to ~90 MB. Per-arch DMGs are 8–24 MB; a universal one with a full libmpv would not fit. |
| Cold start | Home interactive ≤ 2 s from cache | **Later launches: Home interactive ≤ 2 s from cache. First launch after install: first paint ≤ 5 s.** | The warm shell paints in 0.5–1.0 s on all three OSes, which leaves ~1 s for Home. A Windows first launch took 3.5–4.8 s, all of it WebView2 creating its profile. |
| Idle memory | ≤ 250 MB with Home open | **Unchanged: ≤ 250 MB with Home open** on Windows and macOS, measured as Task Manager / Activity Monitor show it. **Linux: provisional** until it's measured on a real GPU desktop (#91). | Windows ~100 MB. macOS 203 MB with 200 posters and no virtualisation, so #41's virtualised rows and lazy images are **required**, not optional. Linux numbers without a GPU (260–440 MB for the empty shell) are inflated by software GL and can't decide this. |
| Time to first frame | ≤ 3 s (debrid HTTP, 50 Mbps) | Unchanged | Not measurable until #60 / #53. #87 measures it. |
| Launch → first frame from Continue Watching | ≤ 15 s median | Unchanged | As above. |

We're keeping AppImage in v1 (with its own ceiling) rather than dropping it for Flatpak + `.deb`, because Linux users without Flatpak expect a single-file download.

## Consequences

- Size is set by the libmpv build, not by us (our binary is 9–10 MB per arch). Installers use solid LZMA (NSIS) and ULMO (DMG); the current zlib / UDZO templates cost 25–40 % more. #88's CI check enforces the limits per format.
- Startup must never block first paint on the network or on libmpv. libmpv initialises on a background goroutine; it added nothing to first paint in #7.
- **Linux on Ubuntu 24.04:** AppArmor blocks the user namespaces that WebKitGTK's sandbox needs, so the app aborts at startup. The `.deb` installs an AppArmor profile granting `userns`. Disabling WebKit's sandbox is not an option.
- If #91 shows WebKitGTK alone idles near 250 MB on a real desktop, Linux gets its own memory target in a follow-up ADR.
