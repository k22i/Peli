//go:build !ios

package player

import (
	"strconv"
	"strings"
)

// Stats reads the stats overlay's numbers from the session.
func (s *Service) Stats() (Stats, error) {
	ses := s.current()
	if ses == nil {
		return Stats{}, ErrNotPlaying
	}
	str := func(name string) string {
		v, err := ses.m.getString(name)
		if err != nil {
			return ""
		}
		return v
	}
	num := func(name string) float64 {
		f, err := strconv.ParseFloat(str(name), 64)
		if err != nil {
			return 0
		}
		return f
	}
	st := s.Snapshot()
	out := Stats{
		VideoCodec:   str("current-tracks/video/codec"),
		Width:        int(num("video-params/w")),
		Height:       int(num("video-params/h")),
		FPS:          num("estimated-vf-fps"),
		PixelFormat:  str("video-params/hw-pixelformat"),
		Gamma:        str("video-params/gamma"),
		Primaries:    str("video-params/primaries"),
		ColorMatrix:  str("video-params/colormatrix"),
		HDRShown:     st.HDR,
		OutputWidth:  int(num("video-out-params/dw")),
		OutputHeight: int(num("video-out-params/dh")),
		HWDec:        st.HWDec,
		// mpv counts its drops as ints; a float parse takes them too.
		DroppedFrames: int64(num("frame-drop-count")),
		DecoderDrops:  int64(num("decoder-frame-drop-count")),
		AudioCodec:    str("current-tracks/audio/codec"),
		AudioChannels: int(num("audio-params/channel-count")),
		VideoBitrate:  num("video-bitrate"),
		AudioBitrate:  num("audio-bitrate"),
		CacheSeconds:  st.Buffered,
		CacheSpeed:    num("cache-speed"),
		Renderer:      str("current-vo"),
		GPUContext:    str("current-gpu-context"),
		DisplayFPS:    num("display-fps"),
	}
	if out.FPS == 0 {
		out.FPS = num("container-fps")
	}
	if out.PixelFormat == "" {
		out.PixelFormat = str("video-params/pixelformat")
	}
	if cache, err := ses.m.getNode("demuxer-cache-state"); err == nil {
		m, _ := cache.(map[string]any)
		out.CacheBytes = int64(number(m["fw-bytes"]))
	}
	out.VideoCodec = strings.TrimSpace(out.VideoCodec)
	return out, nil
}
