package player

/*
#cgo LDFLAGS: -framework MediaPlayer
#include <stdlib.h>

void peli_media_start(void);
void peli_media_show(const char *title, const char *artist, int paused, double position, double duration, double speed);
void peli_media_clear(void);
*/
import "C"

import (
	"sync"
	"unsafe"
)

// darwinMedia is Now Playing and the remote commands (media keys, the
// Control Center widget, AirPods, the Touch Bar), in media_darwin.m.
type darwinMedia struct {
	started bool
}

var (
	mediaCommandsMu sync.Mutex
	mediaCommands   func(mediaCommand, float64)
)

func newMediaControls(commands func(mediaCommand, float64)) mediaControls {
	mediaCommandsMu.Lock()
	mediaCommands = commands
	mediaCommandsMu.Unlock()
	return &darwinMedia{}
}

// show names an episode as macOS does a song: the episode as the title,
// the series as the artist.
func (d *darwinMedia) show(st *mediaState) {
	if st == nil {
		if d.started {
			d.started = false
			C.peli_media_clear()
		}
		return
	}
	if !d.started {
		d.started = true
		C.peli_media_start()
	}
	title, artist := st.Title, ""
	if st.Subtitle != "" {
		title, artist = st.Subtitle, st.Title
	}
	ctitle, cartist := C.CString(title), C.CString(artist)
	defer C.free(unsafe.Pointer(ctitle))
	defer C.free(unsafe.Pointer(cartist))
	C.peli_media_show(ctitle, cartist, cbool(st.Paused), C.double(st.Position), C.double(st.Duration), C.double(st.Speed))
}

//export peliMediaCommand
func peliMediaCommand(command C.int, value C.double) {
	mediaCommandsMu.Lock()
	commands := mediaCommands
	mediaCommandsMu.Unlock()
	if commands != nil {
		// Off the main thread: the service may wait on mpv.
		go commands(mediaCommand(command), float64(value))
	}
}
