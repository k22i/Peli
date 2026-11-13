//go:build ios

// The in-app sign-in page (auth_ios.m).
#ifndef PELI_AUTH_IOS_H
#define PELI_AUTH_IOS_H

// peli_auth_open shows address in an ASWebAuthenticationSession over the app
// and returns 0, or a negative step: -1 not a web address, -2 no window to
// present over, -3 the session would not start. The session never matches
// its callback scheme; it ends when peli_auth_close is called or the user
// taps Cancel (then peliAuthEnded runs).
int peli_auth_open(const char *address, const char *callbackScheme);
// peli_auth_close dismisses the sheet, if it is up.
void peli_auth_close(void);
// Exported from auth_ios.go: the user dismissed the sheet.
void peliAuthEnded(void);

#endif
