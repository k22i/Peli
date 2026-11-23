package main

import "testing"

func TestRetimeSRT(t *testing.T) {
	in := "1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hello</i>\r\n\r\n2\r\n01:59:59,900 --> 02:00:01,000\r\nBye\r\n"
	out := string(Retime([]byte(in), func(int64) float64 { return -2000 }))
	// the first line is pushed before 0: it's clipped, not moved
	want := "1\r\n00:00:00,000 --> 00:00:01,000\r\n<i>Hello</i>\r\n\r\n2\r\n01:59:57,900 --> 01:59:59,000\r\nBye\r\n"
	if out != want {
		t.Errorf("got %q", out)
	}
	if c := ParseSubtitle([]byte(out)); len(c) != 2 || c[1].Start != 7_197_900 {
		t.Errorf("reparsed %+v", c)
	}
}

func TestRetimeASS(t *testing.T) {
	in := "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:01:02.50,0:01:04.00,Default,,0,0,0,,{\\an8}Hi\\Nthere\n"
	out := string(Retime([]byte(in), func(int64) float64 { return 1234 }))
	want := "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:01:03.73,0:01:05.23,Default,,0,0,0,,{\\an8}Hi\\Nthere\n"
	if out != want {
		t.Errorf("got %q", out)
	}
}

func TestRetimeVTT(t *testing.T) {
	in := "WEBVTT\n\n00:10.000 --> 00:12.500 align:start\nHi\n"
	out := string(Retime([]byte(in), func(int64) float64 { return 500 }))
	if want := "WEBVTT\n\n00:00:10.500 --> 00:00:13.000 align:start\nHi\n"; out != want {
		t.Errorf("got %q", out)
	}
}
