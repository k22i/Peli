package player

import (
	"strconv"
	"strings"
)

// Stats is what the stats overlay (Shift+I) shows of the file playing and
// how it plays. Numbers mpv doesn't know (yet) are 0, strings "". The
// frontend asks once a second, and only while the overlay is open: each
// call reads a dozen properties from mpv.
type Stats struct {
	// The video: codec ("hevc"), its size, frames a second and pixel
	// format ("yuv420p10", the hardware decoder's own where there is one).
	VideoCodec  string  `json:"videoCodec"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	FPS         float64 `json:"fps"`
	PixelFormat string  `json:"pixelFormat"`
	// The picture's colour: transfer ("pq", "hlg", "bt.1886"), primaries
	// ("bt.2020") and matrix ("dolbyvision" for Dolby Vision), mpv's names.
	Gamma       string `json:"gamma"`
	Primaries   string `json:"primaries"`
	ColorMatrix string `json:"colorMatrix"`
	// HDRShown is whether it goes to the display as HDR (#66) rather than
	// tone-mapped.
	HDRShown bool `json:"hdrShown"`
	// The size it's drawn at in the window.
	OutputWidth  int `json:"outputWidth"`
	OutputHeight int `json:"outputHeight"`
	// HWDec is the hardware decoder in use, "" for software.
	HWDec string `json:"hwdec"`
	// Frames dropped: by the renderer to keep in sync, and by the decoder
	// when it falls behind.
	DroppedFrames int64 `json:"droppedFrames"`
	DecoderDrops  int64 `json:"decoderDrops"`
	// The sound: codec ("eac3") and channels.
	AudioCodec    string `json:"audioCodec"`
	AudioChannels int    `json:"audioChannels"`
	// Bitrates, in bits a second, as the demuxer measures them.
	VideoBitrate float64 `json:"videoBitrate"`
	AudioBitrate float64 `json:"audioBitrate"`
	// The cache ahead: seconds, bytes, and how fast it fills, in bytes a
	// second.
	CacheSeconds float64 `json:"cacheSeconds"`
	CacheBytes   int64   `json:"cacheBytes"`
	CacheSpeed   float64 `json:"cacheSpeed"`
	// The renderer: mpv's VO ("libmpv", "gpu-next") and its GPU context
	// ("d3d11"), "" where the render API has none to name.
	Renderer   string  `json:"renderer"`
	GPUContext string  `json:"gpuContext"`
	DisplayFPS float64 `json:"displayFps"`
}

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
