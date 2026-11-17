//go:build ios

// The Home Screen icon menu (quickactions_ios.m, #141).
#ifndef PELI_QUICKACTIONS_IOS_H
#define PELI_QUICKACTIONS_IOS_H

// peli_quickactions_set replaces UIApplication.shortcutItems with the
// dynamic items in json (a list of quickactions.Item). Info.plist's static
// ones always stay in front.
void peli_quickactions_set(const char *json);

// Exported from quickactions_ios.go: a tap on an item.
void peliQuickAction(char *kind, char *info);

#endif
