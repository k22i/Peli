package party

import (
	"errors"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/store"
)

var colour = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// Who returns who this device is in a party: the profile in use in db, as
// the others see it, signed in when signedIn says so. It isn't a method, so
// Wails doesn't bind it.
func Who(db *store.Service, signedIn func() (bool, error)) func() (Me, error) {
	var once sync.Mutex
	device := ""
	return func() (Me, error) {
		s := store.Opened(db)
		if s == nil {
			return Me{}, errors.New("party: the store isn't open")
		}
		profile, ok, err := s.ProfileInUse()
		if err != nil || !ok {
			return Me{}, errors.Join(errors.New("party: no profile in use"), err)
		}
		once.Lock()
		if device == "" {
			device, err = s.DeviceID()
		}
		id := device
		once.Unlock()
		if err != nil {
			return Me{}, err
		}
		in, _ := signedIn()
		return meOf(profile, id, in), nil
	}
}

func meOf(p store.Profile, deviceID string, signedIn bool) Me {
	name := strings.TrimSpace(p.Name)
	if utf8.RuneCountInString(name) > 40 {
		name = string([]rune(name)[:40])
	}
	id := backend.PartyIdentity{DeviceID: deviceID, DisplayName: cmpOr(name, defaultName), ProfileIndex: p.NuvioIndex}
	if strings.HasPrefix(p.Avatar, "https://") && len(p.Avatar) <= 512 {
		id.AvatarURL = p.Avatar
	}
	if colour.MatchString(p.AvatarColor) {
		id.AvatarColor = p.AvatarColor
	}
	return Me{
		Identity: id, ProfileID: p.ID, Kids: p.Kids,
		Linked: signedIn && p.NuvioIndex != nil && !p.Guest,
	}
}
