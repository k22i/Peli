//go:build ios

package secrets

// osBackend is the iOS Keychain (ADR-0055, ADR-0057): SecItem generic
// passwords of Peli's own (keychain_ios.go), class
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, so a push in the
// background can read the session while the device is locked, and nothing
// leaves the device in a backup. Wails' application.Mobile.SecureSet is not
// used: it fixes the class at WhenUnlockedThisDeviceOnly.
func osBackend() backend {
	return mobile{keyValues{
		set:    keychainSet,
		get:    keychainGet,
		delete: keychainDelete,
	}}
}
