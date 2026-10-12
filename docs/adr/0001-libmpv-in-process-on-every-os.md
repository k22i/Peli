---
status: accepted
date: 2026-10-12
---

# libmpv in-process on every OS, not an mpv child process

Playback uses libmpv linked into the app through cgo on Windows, macOS and Linux, behind one Go binding and one command / property / event model. We don't ship mpv as a child process driven over JSON IPC, not even as a fallback. macOS and native Wayland can't embed another process's window ([#2](../spikes/mpv-wid-ipc.md)), so they need libmpv's render API ([#4](../spikes/mpv-render-api.md)) whatever we pick. Using libmpv on Windows and X11 too gives the same picture as the child process with fewer moving parts: no orphaned processes, sockets or named pipes, and mpv is ready in single-digit milliseconds instead of 100–560 ms ([#3](../spikes/libmpv-cgo.md)). The only new cgo is on Windows, which cross-compiles from Linux with mingw-w64.

## Considered options

- **mpv child process with `--wid` + JSON IPC everywhere.** Fails on macOS and native Wayland.
- **Hybrid: child process on Windows / X11, libmpv render API on macOS / Wayland.** Two playback paths to build, test and package, for no visible gain.
- **libmpv in-process everywhere.** Chosen.

## Consequences

- **We lose crash isolation.** A crash in libmpv or FFmpeg, e.g. on a malformed stream, now takes the whole app down. A child process could have been restarted. We accept this for v1. A trimmed FFmpeg (ADR-0003) means less code that can crash, and opt-in crash reports (#90) tell us how often it happens. If crash-free sessions fall below the 99.5 % target because of libmpv, revisit with an out-of-process player on Windows / X11, where `wid` would still work across processes.
- Binding rules from #3 / #4 are part of the decision, not implementation detail: one goroutine owns `mpv_wait_event`, never call the client API from the UI thread, the render thread or mpv's callbacks, stop the event loop with `mpv_wakeup` before `mpv_terminate_destroy`, and set `LC_NUMERIC=C` before `mpv_create` on Linux.
- libmpv becomes a build input on every OS, so we build and pin our own (ADR-0003).
