//go:build ios

// What the Objective-C side of the iOS download platform exposes to Go
// (platform_ios.m).
#ifndef PELI_DOWNLOADS_IOS_H
#define PELI_DOWNLOADS_IOS_H

// peli_dl_free_space writes the bytes available to the app on dir's volume
// ("important usage" capacity, which counts what iOS would free). 0 on success.
int peli_dl_free_space(const char *dir, long long *out);
// peli_dl_exclude_backup sets NSURLIsExcludedFromBackupKey on path. 0 on success.
int peli_dl_exclude_backup(const char *path);
// peli_dl_network_start starts the path monitor once; changes arrive through
// peliDownloadsNetwork (exported from platform_ios.go) on the monitor's queue.
void peli_dl_network_start(void);
// peli_dl_lifecycle_observe has Go told when the app backgrounds
// (PELI_DL_BACKGROUND) and becomes active (PELI_DL_ACTIVE). Installed once.
#define PELI_DL_BACKGROUND 1
#define PELI_DL_ACTIVE 2
void peli_dl_lifecycle_observe(void);
// peli_dl_background_begin asks for background time and returns the task id
// (UIBackgroundTaskInvalid is 0 here). While held, a 1 s timer calls
// peliDownloadsExpiring(id, 1) when under 5 s remain; the OS expiration
// handler calls peliDownloadsExpiring(id, 0) and then ends the task.
unsigned long peli_dl_background_begin(void);
// peli_dl_background_end ends the task and stops its timer. Safe to repeat.
void peli_dl_background_end(unsigned long id);

// Exported from platform_ios.go.
void peliDownloadsNetwork(int online, int expensive);
void peliDownloadsLifecycle(int kind);
void peliDownloadsExpiring(unsigned long id, int early);

#endif
