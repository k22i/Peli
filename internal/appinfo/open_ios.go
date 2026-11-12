//go:build ios

package appinfo

import "github.com/wailsapp/wails/v3/pkg/application"

// UIApplication openURL: on the main thread, in Safari.
func openURL(address string) error {
	application.Mobile.OpenURL(address)
	return nil
}
