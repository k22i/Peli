package secrets

import "github.com/wailsapp/wails/v3/pkg/application"

// osBackend is the iOS Keychain through Wails (ADR-0055): SecItem items of
// class generic password, kSecAttrAccessibleWhenUnlockedThisDeviceOnly. So a
// secret can't be read while the device is locked (a push in the background
// after a lock fails until the next unlock) and doesn't leave the device in a
// backup.
func osBackend() backend {
	return mobile{keyValues{
		set:    application.Mobile.SecureSet,
		get:    application.Mobile.SecureGet,
		delete: application.Mobile.SecureDelete,
	}}
}
