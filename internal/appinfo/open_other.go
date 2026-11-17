//go:build !ios

package appinfo

import (
	"errors"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func openURL(address string) error {
	app := application.Get()
	if app == nil {
		return errors.New("appinfo: the app is not running")
	}
	return app.Browser.OpenURL(address)
}

func build() string { return "" }

func pageReady() {}

func openSignIn(address string) error { return openURL(address) }

func closeSignIn() {}
