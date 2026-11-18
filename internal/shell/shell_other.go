//go:build !ios

package shell

// The desktop has no native tab bar: the twins of shell_ios.go.

func setTabBar(TabBarState) error { return nil }

func tabBarHeight() float64 { return 0 }

func watchStatusBar() error { return nil }

func hardwareKeyboard() bool { return false }
