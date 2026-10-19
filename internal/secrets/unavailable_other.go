//go:build !linux

package secrets

const unavailableHint = "the OS keychain is unavailable"

// isUnavailable is Linux-only: the macOS Keychain and Windows Credential
// Manager are always there.
func isUnavailable(error) bool { return false }
