// Package appinfo exposes build information about the app to the frontend.
package appinfo

// Version is the app version. Release builds set it with
// -ldflags "-X github.com/k22i/Sinag/internal/appinfo.Version=<version>".
var Version = "0.0.0-dev"

// Service is the Wails service the frontend calls for app information.
type Service struct{}

// Version returns the app version.
func (Service) Version() string {
	return Version
}
