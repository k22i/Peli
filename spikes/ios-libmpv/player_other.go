//go:build !ios

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// The spike only runs on iOS; this keeps `go build ./...` and `go vet` honest on the desktop.
type Player struct {
	app *application.App
	win *application.WebviewWindow
}

func (p *Player) autostart() {}
