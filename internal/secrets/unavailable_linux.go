package secrets

import (
	"errors"
	"strings"

	"github.com/godbus/dbus/v5"
)

const unavailableHint = "no Secret Service is running; install and start gnome-keyring or KWallet to sign in"

// isUnavailable reports whether err means there is no Secret Service to talk
// to: no session bus at all, or nothing on it that owns
// org.freedesktop.secrets. Other errors, such as a dismissed unlock prompt,
// are passed through as they are.
func isUnavailable(err error) bool {
	var dbusErr dbus.Error
	if errors.As(err, &dbusErr) {
		return dbusErr.Name == "org.freedesktop.DBus.Error.ServiceUnknown" ||
			dbusErr.Name == "org.freedesktop.DBus.Error.NameHasNoOwner" ||
			strings.HasPrefix(dbusErr.Name, "org.freedesktop.DBus.Error.Spawn.")
	}
	_, busErr := dbus.SessionBus()
	return busErr != nil
}
