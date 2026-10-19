package secrets

import (
	"errors"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestNoSecretService(t *testing.T) {
	for _, name := range []string{
		"org.freedesktop.DBus.Error.ServiceUnknown",
		"org.freedesktop.DBus.Error.NameHasNoOwner",
		"org.freedesktop.DBus.Error.Spawn.ChildExited",
	} {
		k := mock(t, dbus.Error{Name: name})
		if _, err := k.Get("trakt.token"); !errors.Is(err, ErrUnavailable) {
			t.Errorf("%s: Get = %v, want ErrUnavailable", name, err)
		}
	}
}
