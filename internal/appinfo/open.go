package appinfo

import (
	"errors"
	"net/url"
)

// ErrNotWebURL means OpenURL was asked for something that isn't an http or
// https address.
var ErrNotWebURL = errors.New("appinfo: not a web address")

// OpenURL opens a web address outside the app: the default browser on a
// desktop, Safari on iOS. The frontend's own Browser.OpenURL from the Wails
// runtime shells out to `open`, which iOS has no process to run, so every
// "open this page" there goes through this method (lib/open-url.ts).
func (Service) OpenURL(address string) error {
	u, err := url.Parse(address)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ErrNotWebURL
	}
	return openURL(u.String())
}

// OpenSignInPage shows a sign-in page that needs Peli to keep running: on iOS
// a sheet over the app (an ASWebAuthenticationSession), since Safari would
// put the app in the background and suspend it before the page can call
// back (AniList's loopback redirect, ADR-0059). Elsewhere it is OpenURL.
// CloseSignInPage dismisses it.
func (Service) OpenSignInPage(address string) error {
	u, err := url.Parse(address)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ErrNotWebURL
	}
	return openSignIn(u.String())
}

// CloseSignInPage dismisses the page OpenSignInPage showed, if it is up.
func (Service) CloseSignInPage() { closeSignIn() }
