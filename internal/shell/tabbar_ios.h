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

// peli_statusbar_watch makes a status-bar tap send shell:scroll-top (#135):
// a 1 pt scroll view over vc's view takes UIKit's scroll-to-top, and the
// webView's own scroll view stops taking it. Safe to call again. 0, or -1
// not a view controller, -2 no webView.
int peli_statusbar_watch(void *vc);

// peli_keyboard_watch (keyboard_ios.m, #138) answers whether a hardware
// keyboard is attached (1) or not (0), and on the first call starts sending
// peliShellKeyboard on GCKeyboardDidConnect / DidDisconnect.
int peli_keyboard_watch(void);

// peli_focus_allow_keyboard (focus_ios.m) lets the next webview focus within
// seconds show the on-screen keyboard, as if the user had tapped the field:
// the native Search button's tap is outside the webview, so the field's
// focus() that follows would otherwise leave the keyboard down.
void peli_focus_allow_keyboard(double seconds);

// Exported from shell_ios.go: the native taps.
void peliShellTab(char *id);
void peliShellSearch(void);
void peliShellExpand(void);
void peliShellScrollTop(void);
void peliShellKeyboard(int attached);

#endif
