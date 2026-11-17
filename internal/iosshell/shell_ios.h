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

// Exported from shell_ios.go.
// peliWebContentTerminated returns the address to load next (malloc'd, the
// caller frees it) and sets *action: 0 reload, 1 home, 2 the error page
// (then the address is NULL).
char *peliWebContentTerminated(char *current, int *action);
void peliNavigationFailed(char *kind, char *url, char *reason);
void peliMemoryWarning(void);

#endif
