---
status: accepted
date: 2026-10-12
---

# How video reaches the window, per OS

There is no single way to put libmpv's video under the webview on all three OSes. libmpv's render API is OpenGL / software only, with no Direct3D, and `wid` embedding doesn't exist on macOS or Wayland. So each OS gets a small native host (~300 lines) on the shared binding from ADR-0001. Every host keeps the transparent webview on top, in one window, and receives no input itself:

| OS | Host | Evidence |
|---|---|---|
| **Windows** | `wid` embedding: mpv's child HWND under Wails' window, pushed to `HWND_BOTTOM` and disabled. Re-assert this after a VO re-init. WebView2 composition hosting worked just as well and is the fallback if re-asserting proves fragile. | [#2](../spikes/mpv-wid-ipc.md), [#3](../spikes/libmpv-cgo.md) |
| **macOS** | Render API into a `CAOpenGLLayer` view below the `WKWebView`. `display` is driven from our own serial queue, not the main thread. | [#4](../spikes/mpv-render-api.md) |
| **Linux, X11 and Wayland** | Render API on our own render thread, handing fenced `GdkGLTexture`s to a `GtkPicture` below the webview (`gltex`, GTK ≥ 4.12). | [#4](../spikes/mpv-render-api.md) |

**Rendering never runs on the UI thread.** By default `mpv_render_context_render` blocks until the frame's display time. On the main thread that froze macOS for ~14 ms of every frame, and on GTK it starved Wails' idle-priority main-thread dispatch for up to 176 s. That's why we rejected `GtkGLArea`, the usual GTK + libmpv recipe.

## Considered options

- **Render API everywhere.** It isn't available on Windows without WGL / ANGLE interop with WebView2, which nobody has tested. Rejected for v1.
- **`wid` + a second transparent overlay window on X11** (#2 / #3). This depends on the window manager for stacking and positioning, and needs a compositor. `gltex` replaces it with one window. It stays the fallback if `gltex` is too expensive on real GPUs.
- **Our own `wl_subsurface` under GTK's surface on Wayland.** Cheapest in the GPU-less containers, but Wayland-only and it hand-rolls protocol on GDK's connection. This is the Wayland fallback.

## Consequences

- **X11 isn't settled until we measure it.** In GPU-less containers `gltex` cost ~1.8× the CPU of `wid` + overlay. On a real GPU that should mostly close, but nobody has measured it. #91 measures it on a real Linux desktop during M1. If `gltex` is clearly worse there, X11 falls back to `wid` + overlay, and Wayland to `subsurface`.
- **HDR on macOS is unverified on screen.** HDR values survive into a half-float EDR layer, but no EDR display was available. The render API is also OpenGL-only, which is deprecated on macOS, and mpv's Metal path isn't exposed to embedders. #66 has to check this on an HDR / XDR display.
- Wails beta.28 workarounds the hosts depend on: macOS `drawsBackground = NO` set by hand, GTK window transparency via CSS (`setTransparent()` is a stub), and reparenting Wails' `WebKitWebView` into a `GtkOverlay` at runtime. A Wails upgrade can break any of these, so #60 tests each one.
