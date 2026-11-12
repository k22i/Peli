//go:build ios && pelidev

package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The simulator remote control (build tag pelidev, never in a shipped build):
// there is no Simulator.app or input tool here, so a script drives the app
// through files in $PELI_DEV_DIR (SIMCTL_CHILD_PELI_DEV_DIR).
//
//   - cmd.js, when it appears, runs in the webview and is deleted.
//   - the page answers by fetch("/__dev/out", {method: "POST", body}), which
//     is appended to out.txt next to it.
//   - $PELI_DEV_EMAIL and $PELI_DEV_PASSWORD, when both are set and nobody
//     is signed in, sign in once at launch through Account.SignIn. Neither
//     is ever logged or written anywhere.

func devAssets(next http.Handler) http.Handler {
	dir := os.Getenv("PELI_DEV_DIR")
	if dir == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__dev/out" {
			next.ServeHTTP(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		f, err := os.OpenFile(filepath.Join(dir, "out.txt"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			f.Write(append(body, '\n'))
			f.Close()
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func devStart(app *application.App, window *application.WebviewWindow, p *peli) {
	dir := os.Getenv("PELI_DEV_DIR")
	if dir == "" {
		return
	}
	if email, password := os.Getenv("PELI_DEV_EMAIL"), os.Getenv("PELI_DEV_PASSWORD"); email != "" && password != "" {
		go func() {
			time.Sleep(3 * time.Second)
			if _, err := p.accounts.SignIn(context.Background(), email, password); err != nil {
				log.Printf("dev sign-in failed") // never the error: it may echo the email
			} else {
				log.Printf("dev sign-in done")
			}
		}()
	}
	go func() {
		cmd := filepath.Join(dir, "cmd.js")
		for {
			time.Sleep(500 * time.Millisecond)
			js, err := os.ReadFile(cmd)
			if err != nil {
				continue
			}
			os.Remove(cmd)
			window.ExecJS(string(js))
		}
	}()
}
