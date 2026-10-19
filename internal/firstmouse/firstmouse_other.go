//go:build !darwin

package firstmouse

// Enable is a no-op: WebView2 and WebKitGTK already act on the first click.
func Enable() {}
