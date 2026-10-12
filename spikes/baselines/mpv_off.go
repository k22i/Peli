//go:build !mpv

package main

const mpvLinked = false

func initMPV() map[string]any { return nil }
