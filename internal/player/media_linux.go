package player

import (
	"fmt"
	"log/slog"
	"math"
	"os"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
)

// MPRIS (https://specifications.freedesktop.org/mpris-spec/latest/): the
// desktop's media widget and media keys (GNOME, KDE, playerctl) find
// players by their bus name.
const (
	mprisName   = "org.mpris.MediaPlayer2.peli"
	mprisPath   = dbus.ObjectPath("/org/mpris/MediaPlayer2")
	mprisRoot   = "org.mpris.MediaPlayer2"
	mprisPlayer = "org.mpris.MediaPlayer2.Player"
	dbusProps   = "org.freedesktop.DBus.Properties"
)

// mpris owns the bus name while something plays, and gives it up when the
// session ends, so the widget only lists Peli while it plays. The previous
// and next buttons are off: a film has no tracks, and the next episode is
// the screen's to offer.
type mpris struct {
	commands func(mediaCommand, float64)
	// connect opens a private connection to the session bus; tests point it
	// at their own bus.
	connect func() (*dbus.Conn, error)

	mu     sync.Mutex
	conn   *dbus.Conn
	warned bool
	st     *mediaState
	// at is when st was shown, to move its position on while it plays.
	at time.Time
	// track numbers each thing played, for mpris:trackid.
	track int
}

func newMediaControls(commands func(mediaCommand, float64)) mediaControls {
	return &mpris{commands: commands, connect: func() (*dbus.Conn, error) { return dbus.ConnectSessionBus() }}
}

func (m *mpris) show(st *mediaState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if st == nil {
		if m.conn != nil {
			// Closing releases the name: the player leaves the widget.
			_ = m.conn.Close()
			m.conn, m.st = nil, nil
		}
		return
	}
	if m.conn == nil {
		if err := m.open(); err != nil {
			if !m.warned {
				m.warned = true
				slog.Info("player: no MPRIS media controls", "error", err)
			}
			return
		}
	}
	prev := m.st
	if prev == nil || prev.NowPlaying != st.NowPlaying {
		m.track++
	}
	m.st, m.at = st, time.Now()
	changed := map[string]dbus.Variant{}
	now := m.playerProps()
	if prev == nil {
		changed = now
	} else {
		for _, name := range []string{"PlaybackStatus", "Metadata", "Rate", "CanSeek"} {
			changed[name] = now[name]
		}
	}
	delete(changed, "Position")
	_ = m.conn.Emit(mprisPath, dbusProps+".PropertiesChanged", mprisPlayer, changed, []string{})
	if prev != nil && prev.Seeks != st.Seeks {
		_ = m.conn.Emit(mprisPath, mprisPlayer+".Seeked", micros(st.Position))
	}
}

// open connects, puts the two interfaces on the bus and takes the name, or
// an instance name when another Peli has it. m.mu must be held.
func (m *mpris) open() error {
	conn, err := m.connect()
	if err != nil {
		return err
	}
	for _, export := range []struct {
		v       any
		renamed map[string]string
		iface   string
	}{
		{mprisRootMethods{}, nil, mprisRoot},
		{mprisPlayerMethods{m}, map[string]string{"SeekBy": "Seek"}, mprisPlayer},
		{mprisPropsMethods{m}, nil, dbusProps},
		{introspect.Introspectable(mprisIntrospection), nil, "org.freedesktop.DBus.Introspectable"},
	} {
		if err := conn.ExportWithMap(export.v, export.renamed, mprisPath, export.iface); err != nil {
			_ = conn.Close()
			return err
		}
	}
	for _, name := range []string{mprisName, fmt.Sprintf("%s.instance%d", mprisName, os.Getpid())} {
		reply, err := conn.RequestName(name, dbus.NameFlagDoNotQueue)
		if err != nil {
			_ = conn.Close()
			return err
		}
		if reply == dbus.RequestNameReplyPrimaryOwner {
			m.conn = conn
			return nil
		}
	}
	_ = conn.Close()
	return fmt.Errorf("%s is taken", mprisName)
}

// position is where playback is now, moved on from the last state shown.
// m.mu must be held.
func (m *mpris) position() float64 {
	st := m.st
	if st == nil {
		return 0
	}
	pos := st.Position
	if !st.Paused {
		pos += st.Speed * time.Since(m.at).Seconds()
	}
	if st.Duration > 0 {
		pos = math.Min(pos, st.Duration)
	}
	return pos
}

// playerProps are the Player interface's properties. m.mu must be held.
func (m *mpris) playerProps() map[string]dbus.Variant {
	st := m.st
	if st == nil {
		st = &mediaState{Paused: true, Speed: 1}
	}
	status := "Playing"
	if st.Paused {
		status = "Paused"
	}
	if m.st == nil {
		status = "Stopped"
	}
	// An episode is named as a song is: the episode as the title, the series
	// as the artist.
	title, artists := st.Title, []string{}
	if st.Subtitle != "" {
		title, artists = st.Subtitle, []string{st.Title}
	}
	metadata := map[string]dbus.Variant{
		"mpris:trackid": dbus.MakeVariant(dbus.ObjectPath(fmt.Sprintf("/app/peli/track/%d", m.track))),
		"xesam:title":   dbus.MakeVariant(title),
		"xesam:artist":  dbus.MakeVariant(artists),
	}
	if st.Duration > 0 {
		metadata["mpris:length"] = dbus.MakeVariant(micros(st.Duration))
	}
	return map[string]dbus.Variant{
		"PlaybackStatus": dbus.MakeVariant(status),
		"Rate":           dbus.MakeVariant(st.Speed),
		"MinimumRate":    dbus.MakeVariant(0.25),
		"MaximumRate":    dbus.MakeVariant(4.0),
		"Metadata":       dbus.MakeVariant(metadata),
		"Volume":         dbus.MakeVariant(1.0),
		"Position":       dbus.MakeVariant(micros(m.position())),
		"CanGoNext":      dbus.MakeVariant(false),
		"CanGoPrevious":  dbus.MakeVariant(false),
		"CanPlay":        dbus.MakeVariant(true),
		"CanPause":       dbus.MakeVariant(true),
		"CanSeek":        dbus.MakeVariant(st.Duration > 0),
		"CanControl":     dbus.MakeVariant(true),
	}
}

var mprisRootProps = map[string]dbus.Variant{
	"CanQuit":             dbus.MakeVariant(false),
	"CanRaise":            dbus.MakeVariant(false),
	"HasTrackList":        dbus.MakeVariant(false),
	"Identity":            dbus.MakeVariant("Peli"),
	"DesktopEntry":        dbus.MakeVariant("peli"),
	"SupportedUriSchemes": dbus.MakeVariant([]string{}),
	"SupportedMimeTypes":  dbus.MakeVariant([]string{}),
}

func micros(seconds float64) int64 { return int64(math.Round(seconds * 1e6)) }

// mprisRootMethods is org.mpris.MediaPlayer2: Peli can't be raised or
// quit from the widget.
type mprisRootMethods struct{}

func (mprisRootMethods) Raise() *dbus.Error { return nil }
func (mprisRootMethods) Quit() *dbus.Error  { return nil }

// mprisPlayerMethods is org.mpris.MediaPlayer2.Player.
type mprisPlayerMethods struct{ m *mpris }

func (p mprisPlayerMethods) Next() *dbus.Error     { return nil }
func (p mprisPlayerMethods) Previous() *dbus.Error { return nil }
func (p mprisPlayerMethods) Play() *dbus.Error     { return p.run(mediaPlay, 0) }
func (p mprisPlayerMethods) Pause() *dbus.Error    { return p.run(mediaPause, 0) }

// Stop pauses: leaving the player is the screen's to do.
func (p mprisPlayerMethods) Stop() *dbus.Error      { return p.run(mediaPause, 0) }
func (p mprisPlayerMethods) PlayPause() *dbus.Error { return p.run(mediaToggle, 0) }

// SeekBy is Seek, renamed for go vet (io.Seeker): it moves by offset
// microseconds.
func (p mprisPlayerMethods) SeekBy(offset int64) *dbus.Error {
	return p.run(mediaSeekBy, float64(offset)/1e6)
}

// SetPosition goes to position microseconds into track, when it's still
// the one playing.
func (p mprisPlayerMethods) SetPosition(track dbus.ObjectPath, position int64) *dbus.Error {
	p.m.mu.Lock()
	current := dbus.ObjectPath(fmt.Sprintf("/app/peli/track/%d", p.m.track))
	p.m.mu.Unlock()
	if track != current || position < 0 {
		return nil
	}
	return p.run(mediaSeekTo, float64(position)/1e6)
}

func (p mprisPlayerMethods) OpenUri(string) *dbus.Error {
	return dbus.NewError("org.mpris.MediaPlayer2.Player.Error.NotSupported", []any{"Peli can't open a URI"})
}

func (p mprisPlayerMethods) run(c mediaCommand, value float64) *dbus.Error {
	go p.m.commands(c, value)
	return nil
}

// mprisPropsMethods is org.freedesktop.DBus.Properties, read-only.
type mprisPropsMethods struct{ m *mpris }

func (p mprisPropsMethods) Get(iface, name string) (dbus.Variant, *dbus.Error) {
	all, err := p.GetAll(iface)
	if err != nil {
		return dbus.Variant{}, err
	}
	v, ok := all[name]
	if !ok {
		return dbus.Variant{}, dbus.NewError("org.freedesktop.DBus.Error.UnknownProperty", []any{name})
	}
	return v, nil
}

func (p mprisPropsMethods) GetAll(iface string) (map[string]dbus.Variant, *dbus.Error) {
	switch iface {
	case mprisRoot:
		return mprisRootProps, nil
	case mprisPlayer:
		p.m.mu.Lock()
		defer p.m.mu.Unlock()
		return p.m.playerProps(), nil
	}
	return nil, dbus.NewError("org.freedesktop.DBus.Error.UnknownInterface", []any{iface})
}

func (p mprisPropsMethods) Set(_, name string, _ dbus.Variant) *dbus.Error {
	return dbus.NewError("org.freedesktop.DBus.Error.PropertyReadOnly", []any{name})
}

const mprisIntrospection = `<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg name="Offset" type="x" direction="in"/></method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <method name="OpenUri"><arg name="Uri" type="s" direction="in"/></method>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg name="interface" type="s" direction="in"/>
      <arg name="property" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="GetAll">
      <arg name="interface" type="s" direction="in"/>
      <arg name="properties" type="a{sv}" direction="out"/>
    </method>
    <method name="Set">
      <arg name="interface" type="s" direction="in"/>
      <arg name="property" type="s" direction="in"/>
      <arg name="value" type="v" direction="in"/>
    </method>
    <signal name="PropertiesChanged">
      <arg name="interface" type="s"/>
      <arg name="changed_properties" type="a{sv}"/>
      <arg name="invalidated_properties" type="as"/>
    </signal>
  </interface>
  ` + introspect.IntrospectDataString + `
</node>`
