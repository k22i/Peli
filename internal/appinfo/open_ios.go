//go:build ios

package appinfo

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/iosauth"
	"github.com/k22i/Peli/internal/iosplayer"
)

func build() string { return iosplayer.Build() }

func pageReady() { iosplayer.ShowWebview() }

// UIApplication openURL: on the main thread, in Safari.
func openURL(address string) error {
	application.Mobile.OpenURL(address)
	return nil
}

func openSignIn(address string) error { return iosauth.Open(address, nil) }

func closeSignIn() { iosauth.Close() }
