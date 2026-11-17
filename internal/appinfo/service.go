// Package appinfo exposes build information about the app to the frontend.
package appinfo

// Version is the app version. Release builds set it with
// -ldflags "-X github.com/k22i/Peli/internal/appinfo.Version=<version>".
var Version = "0.0.0-dev"

// Service is the Wails service the frontend calls for app information.
type Service struct{}

// Build returns the build number of the running app: CFBundleVersion on iOS
// (SideStore builds stamp YYYYMMDD.HHMM), "" elsewhere.
func (Service) Build() string {
	return build()
}

// PageReady tells the app the page has started (DOMContentLoaded), so on iOS
// the webview, kept clear since launch to avoid a white flash, fades in.
// Nothing elsewhere.
func (Service) PageReady() {
	pageReady()
}

// Version returns the app version.
func (Service) Version() string {
	return Version
}
