//go:build ios

// What the Objective-C side exposes to Go. Everything is plain C so the cgo
// preamble in player_ios.go stays small.
#ifndef MPVVIEW_H
#define MPVVIEW_H

// Called (from an mpv thread) for each property change or log line: name is
// "time-pos", "pause", "track-list", ..., "log"; json is the value as JSON.
void goMpvEvent(char *name, char *json);

// Creates mpv and the GLES video view and inserts the view BEHIND the Wails
// webview of the given WailsViewController (window.NativeWindow()). Returns 0
// when attached, otherwise a negative step number (see mpvview.m).
int peli_attach(void *wailsViewController, const char *hwdec);

// mpv client API, thread-safe. args is NULL-terminated.
int peli_command(const char **args);
int peli_set_property(const char *name, const char *value);
// A malloc'd string (free with peli_free) or NULL.
char *peli_get_property(const char *name);
void peli_free(char *p);
// Render counters and the size of the drawable, as JSON.
char *peli_stats(void);

#endif
