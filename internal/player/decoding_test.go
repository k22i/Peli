package player

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

// hdr10.mp4 is 1 s of 160x90 HEVC Main10, BT.2020 and PQ, with HDR10
// metadata (#66).

type deviceSettings struct {
	settings store.DeviceSettings
	err      error
}

func (d deviceSettings) DeviceSettings() (store.DeviceSettings, error) { return d.settings, d.err }

func TestHardwareDecodingFollowsTheSetting(t *testing.T) {
	t.Parallel()
	path, _ := filepath.Abs("testdata/clip.mp4")
	for name, c := range map[string]struct {
		settings Settings
		want     string
	}{
		"no settings":            {nil, hwdecAPIs},
		"on":                     {deviceSettings{settings: store.DeviceSettings{HardwareDecoding: true}}, hwdecAPIs},
		"off":                    {deviceSettings{settings: store.DeviceSettings{HardwareDecoding: false}}, "no"},
		"settings can't be read": {deviceSettings{err: errors.New("closed")}, hwdecAPIs},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			s, r := newTestService(t)
			if c.settings != nil {
				UseSettings(s, c.settings)
			}
			if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
				t.Fatal(err)
			}
			r.waitFor(t, "the first frame", func(*recorder) bool { return !s.Snapshot().Loading })
			got, err := s.s.m.getString("hwdec")
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Errorf("hwdec %q, want %q", got, c.want)
			}
			if c.want == "no" && s.Snapshot().HWDec != "" {
				t.Errorf("decoding with %q, want software", s.Snapshot().HWDec)
			}
		})
	}
}

// hdrHost is a host that can show HDR, and records when it's asked to.
type hdrHost struct {
	nullHost
	mu    sync.Mutex
	shown []bool
}

func (h *hdrHost) canShowHDR() bool { return true }

func (h *hdrHost) showHDR(on bool) {
	h.mu.Lock()
	h.shown = append(h.shown, on)
	h.mu.Unlock()
}

func TestHDRGoesToADisplayThatShowsIt(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	h := &hdrHost{}
	s.newHost = func() (host, error) { return h, nil }
	hdr, _ := filepath.Abs("testdata/hdr10.mp4")
	sdr, _ := filepath.Abs("testdata/clip.mp4")
	target := func() [2]string {
		t.Helper()
		trc, err := s.s.m.getString("target-trc")
		if err != nil {
			t.Fatal(err)
		}
		prim, err := s.s.m.getString("target-prim")
		if err != nil {
			t.Fatal(err)
		}
		return [2]string{trc, prim}
	}

	if err := s.Load(streams.Source{URL: hdr}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "HDR", func(*recorder) bool { return s.Snapshot().HDR })
	if got := target(); got != [2]string{"pq", "bt.2020"} {
		t.Errorf("target %v, want PQ and BT.2020", got)
	}

	if err := s.Load(streams.Source{URL: sdr}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "SDR", func(*recorder) bool { st := s.Snapshot(); return !st.HDR && !st.Loading })
	if got := target(); got != [2]string{"auto", "auto"} {
		t.Errorf("target %v, want auto (the display's)", got)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.shown) != 2 || !h.shown[0] || h.shown[1] {
		t.Errorf("host asked to show HDR %v, want [true false]", h.shown)
	}
}

func TestHDRIsToneMappedWhereItCantBeShown(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/hdr10.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the end", func(r *recorder) bool { return len(r.ends) > 0 })
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, st := range r.states {
		if st.HDR {
			t.Fatalf("state %+v, want SDR on a host that can't show HDR", st)
		}
	}
	if trc, _ := s.s.m.getString("target-trc"); trc != "auto" {
		t.Errorf("target-trc %q, want auto, so mpv tone-maps to the display", trc)
	}
}
