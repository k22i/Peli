//go:build ios && !pelidev

package main

import (
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The simulator remote control is built only with -tags pelidev (dev_ios.go).
func devAssets(next http.Handler) http.Handler { return next }

func devStart(*application.App, *application.WebviewWindow, *peli) {}
