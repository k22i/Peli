//go:build !ios

package shell

import "context"

// The desktop has no native tab bar and no camera to scan with: the twins of
// shell_ios.go.

func setTabBar(TabBarState) error { return nil }

func tabBarHeight() float64 { return 0 }

func watchStatusBar() error { return nil }

func cameraAccess() string { return CameraUnavailable }

func scanQR(context.Context, string) (string, error) { return "", ErrNoScanner }

func openAppSettings() {}

func hardwareKeyboard() bool { return false }
