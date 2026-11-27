//go:build ios

// Peli's own additions to Wails' iOS shell (shell_ios.m, #127): surviving a
// WebKit content-process kill, memory readings, the share sheet.
#ifndef PELI_SHELL_IOS_H
#define PELI_SHELL_IOS_H

#include <stdint.h>

// peliCrashRecovery adds the termination and navigation-failure handlers to
// Wails' navigation delegate (WailsViewController) and watches for memory
// warnings. build/ios/main.m calls it before UIApplicationMain: WebKit reads
// which delegate methods exist when the delegate is set, in viewDidLoad.
void peliCrashRecovery(void);

// peli_shell_share offers the files in the share sheet over the app.
// Returns 0, or -1 when there is no window to present over.
int peli_shell_share(const char **paths, int n);
// peli_shell_memory is os_proc_available_memory() and the process footprint.
void peli_shell_memory(uint64_t *available, uint64_t *footprint);
// peli_shell_device writes "iOS 27.2 (iPhone15,2)" into buf.
void peli_shell_device(char *buf, int n);

// peli_shell_cellular is 1 when the default route is the cellular network
// (SCNetworkReachability's IsWWAN flag), 0 on Wi-Fi, wired or no network.
int peli_shell_cellular(void);

// peli_shell_trim_web_cache drops WebKit's in-memory cache (decoded images
// with it), on the main thread. The disk cache stays.
void peli_shell_trim_web_cache(void);

// peli_shell_webview_transparent makes the webview and its scroll view
// see-through, idempotently: the video plays in a UIKit view under the
// webview, and this way the player never flips its opacity mid-session.
// Returns 0 once transparent, -1 while the webview isn't loaded yet.
int peli_shell_webview_transparent(void);

// peli_shell_webview_probe draws what the webview shows now, small, and
// writes the mean luma (0-255) into *mean: the shell paints #0e0d0c
// (about 13), a page that stopped painting is 0. Returns 0 once *mean
// means something, -1 while there is no webview.
int peli_shell_webview_probe(uint8_t *mean);

// peli_shell_webview_load loads url in the webview; the empty string shows
// the error page. The string is copied before the call returns.
void peli_shell_webview_load(const char *url);

// peli_shell_install_panic_gesture puts the two-finger triple tap on the
// window, the panic gesture for the iPad black screen: a tap run reaches
// the app even when the page stopped presenting, so the gesture reloads the
// page (shell_ios.go's peliPanicGesture → diagnostics.RecoverWebview).
// Idempotent. Returns 0 once installed, -1 while there is no window.
int peli_shell_install_panic_gesture(void);

// Exported from shell_ios.go.
// peliWebContentTerminated returns the address to load next (malloc'd, the
// caller frees it) and sets *action: 0 reload, 1 home, 2 the error page
// (then the address is NULL).
char *peliWebContentTerminated(char *current, int *action);
void peliNavigationFailed(char *kind, char *url, char *reason);
void peliMemoryWarning(void);
void peliPanicGesture(void);

#endif
