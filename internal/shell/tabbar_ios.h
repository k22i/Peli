//go:build ios

// The floating Liquid Glass tab bar (tabbar_ios.m, #129).
#ifndef PELI_TABBAR_IOS_H
#define PELI_TABBAR_IOS_H

// peli_tabbar_set shows the bar described by json (shell.TabBarState) in the
// view controller vc, over its webView, building it on the first call. It
// returns 0, 1 when there is no native bar (before iOS 26: the frontend draws
// its own), or a negative step: -1 not a view controller, -2 no webView,
// -3 bad JSON.
int peli_tabbar_set(void *vc, const char *json);
// peli_tabbar_height is the capsule's height in points for vc's current size
// class, or 0 when there is no native bar.
double peli_tabbar_height(void *vc);

// Exported from shell_ios.go: the native taps.
void peliShellTab(char *id);
void peliShellSearch(void);
void peliShellExpand(void);

#endif
