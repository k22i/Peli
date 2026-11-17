//go:build ios

// The camera's QR scanner for device pairing (scanner_ios.m, #133).
#ifndef PELI_SCANNER_IOS_H
#define PELI_SCANNER_IOS_H

// peli_camera_access: 0 not asked yet, 1 granted, 2 denied or restricted,
// 3 no camera.
int peli_camera_access(void);
// peli_scan_start presents the scanner full screen over vc (asking for the
// camera first if it hasn't been) and returns at once. It ends with one
// peliShellScanned call: the first QR code starting with prefix ("" for
// any), or a close, a denial or no camera.
void peli_scan_start(void *vc, const char *prefix);
// peli_scan_cancel closes the scanner without a code (no callback).
void peli_scan_cancel(void);

// peli_open_app_settings opens Peli's page in the Settings app.
void peli_open_app_settings(void);

// Exported from shell_ios.go.
void peliShellScanned(char *text, int status);

#endif
