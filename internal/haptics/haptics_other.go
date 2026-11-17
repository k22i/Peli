//go:build !ios

package haptics

// The desktop has no taptic engine: the twin of haptics_ios.go.
func impact(string) {}
