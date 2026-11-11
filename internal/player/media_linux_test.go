package player

import (
	"bufio"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

// privateBus starts a session bus of the test's own, or skips without
// dbus-daemon.
func privateBus(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("dbus-daemon"); err != nil {
		t.Skip("no dbus-daemon")
	}
	cmd := exec.Command("dbus-daemon", "--session", "--nofork", "--print-address=1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	addr, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(addr)
}

func dial(t *testing.T, addr string) *dbus.Conn {
	t.Helper()
	conn, err := dbus.Connect(addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestMPRIS(t *testing.T) {
	addr := privateBus(t)
	commands := make(chan [2]float64, 10)
	m := &mpris{
		commands: func(c mediaCommand, v float64) { commands <- [2]float64{float64(c), v} },
		connect:  func() (*dbus.Conn, error) { return dbus.Connect(addr) },
	}
	client := dial(t, addr)
	if err := client.AddMatchSignal(dbus.WithMatchObjectPath(mprisPath)); err != nil {
		t.Fatal(err)
	}
	signals := make(chan *dbus.Signal, 20)
	client.Signal(signals)

	st := &mediaState{
		NowPlaying: NowPlaying{Title: "Breaking Bad", Subtitle: "S1E2 · Cat's in the Bag..."},
		Position:   600, Duration: 2880, Speed: 1,
	}
	m.show(st)
	player := client.Object(mprisName, mprisPath)
	get := func(iface, name string) dbus.Variant {
		t.Helper()
		v, err := player.GetProperty(iface + "." + name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return v
	}
	if got := get(mprisPlayer, "PlaybackStatus").Value(); got != "Playing" {
		t.Errorf("PlaybackStatus %v", got)
	}
	if got := get(mprisRoot, "Identity").Value(); got != "Peli" {
		t.Errorf("Identity %v", got)
	}
	meta := get(mprisPlayer, "Metadata").Value().(map[string]dbus.Variant)
	if meta["xesam:title"].Value() != "S1E2 · Cat's in the Bag..." ||
		strings.Join(meta["xesam:artist"].Value().([]string), "") != "Breaking Bad" ||
		meta["mpris:length"].Value() != int64(2880e6) {
		t.Errorf("Metadata %v", meta)
	}
	// Playing, the position moves on from the last state.
	time.Sleep(50 * time.Millisecond)
	if pos := get(mprisPlayer, "Position").Value().(int64); pos < 600_040_000 || pos > 601e6 {
		t.Errorf("Position %d", pos)
	}

	// The widget's buttons.
	for _, call := range []struct {
		method string
		args   []any
		want   [2]float64
	}{
		{"PlayPause", nil, [2]float64{float64(mediaToggle), 0}},
		{"Pause", nil, [2]float64{float64(mediaPause), 0}},
		{"Stop", nil, [2]float64{float64(mediaPause), 0}},
		{"Play", nil, [2]float64{float64(mediaPlay), 0}},
		{"Seek", []any{int64(-10e6)}, [2]float64{float64(mediaSeekBy), -10}},
		{"SetPosition", []any{meta["mpris:trackid"].Value(), int64(30e6)}, [2]float64{float64(mediaSeekTo), 30}},
	} {
		if err := player.Call(mprisPlayer+"."+call.method, 0, call.args...).Err; err != nil {
			t.Fatalf("%s: %v", call.method, err)
		}
		select {
		case got := <-commands:
			if got != call.want {
				t.Errorf("%s: %v, want %v", call.method, got, call.want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: no command", call.method)
		}
	}
	// A track that no longer plays isn't moved.
	if err := player.Call(mprisPlayer+".SetPosition", 0, dbus.ObjectPath("/app/peli/track/0"), int64(1)).Err; err != nil {
		t.Fatal(err)
	}
	if err := player.SetProperty(mprisPlayer+".Volume", dbus.MakeVariant(0.5)); err == nil {
		t.Error("Volume was set")
	}

	// A pause and a jump: PropertiesChanged and Seeked.
	drain(signals)
	paused := *st
	paused.Paused, paused.Position, paused.Seeks = true, 30, 1
	m.show(&paused)
	var changed, seeked bool
	for !changed || !seeked {
		select {
		case sig := <-signals:
			switch sig.Name {
			case dbusProps + ".PropertiesChanged":
				props := sig.Body[1].(map[string]dbus.Variant)
				changed = props["PlaybackStatus"].Value() == "Paused"
				if _, ok := props["Position"]; ok {
					t.Error("Position in PropertiesChanged")
				}
			case mprisPlayer + ".Seeked":
				seeked = sig.Body[0] == int64(30e6)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("changed %v, seeked %v", changed, seeked)
		}
	}
	if pos := get(mprisPlayer, "Position").Value().(int64); pos != 30e6 {
		t.Errorf("paused Position %d", pos)
	}

	// Nothing playing: the name goes, and comes back with the next.
	m.show(nil)
	if has := hasOwner(t, client, mprisName); has {
		t.Error("the name is still owned")
	}
	m.show(st)
	if has := hasOwner(t, client, mprisName); !has {
		t.Error("the name wasn't taken again")
	}
	m.show(nil)
}

// A second Peli takes an instance name.
func TestMPRISInstanceName(t *testing.T) {
	addr := privateBus(t)
	connect := func() (*dbus.Conn, error) { return dbus.Connect(addr) }
	first := &mpris{commands: func(mediaCommand, float64) {}, connect: connect}
	second := &mpris{commands: func(mediaCommand, float64) {}, connect: connect}
	st := &mediaState{NowPlaying: NowPlaying{Title: "The Film"}, Speed: 1}
	first.show(st)
	second.show(st)
	defer first.show(nil)
	defer second.show(nil)
	client := dial(t, addr)
	var names []string
	if err := client.BusObject().Call("org.freedesktop.DBus.ListNames", 0).Store(&names); err != nil {
		t.Fatal(err)
	}
	var mine int
	for _, n := range names {
		if strings.HasPrefix(n, mprisName) {
			mine++
		}
	}
	if mine != 2 {
		t.Errorf("names %v, want two of Peli's", names)
	}
}

// No session bus: nothing shows, nothing fails.
func TestMPRISWithoutABus(t *testing.T) {
	m := &mpris{commands: func(mediaCommand, float64) {}, connect: func() (*dbus.Conn, error) {
		return dbus.Connect("unix:path=/nonexistent")
	}}
	m.show(&mediaState{Speed: 1})
	m.show(nil)
}

func hasOwner(t *testing.T, client *dbus.Conn, name string) bool {
	t.Helper()
	var has bool
	if err := client.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, name).Store(&has); err != nil {
		t.Fatal(err)
	}
	return has
}

func drain(c chan *dbus.Signal) {
	for {
		select {
		case <-c:
		default:
			return
		}
	}
}
