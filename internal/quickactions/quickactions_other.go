//go:build !ios

package quickactions

// The desktop has no icon menu: the twin of quickactions_ios.go.

func setItems([]Item) error { return nil }
