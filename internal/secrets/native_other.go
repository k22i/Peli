//go:build !darwin

package secrets

// osBackend is go-keyring everywhere but macOS.
func osBackend() backend { return tool{} }
