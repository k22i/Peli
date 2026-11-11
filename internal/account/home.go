package account

import (
	"context"
	"errors"

	"github.com/k22i/Peli/internal/store"
)

// Editing the home layout (#35, ADR-0022). The layout is made in Nuvio's
// apps, and the PRD forbids pushing it to Nuvio's backend, so a profile
// linked to Nuvio's server follows it as pulled and can't change it here: a
// local edit would never reach the other devices, and the next pull would
// undo it. On a custom server it is pushed like any other change. A profile
// that isn't linked, such as the Guest, keeps its own.

// ErrHomeFromNuvio means the home layout was edited on a profile that gets it
// from Nuvio's server.
var ErrHomeFromNuvio = errors.New("account: the home layout comes from Nuvio's apps on Nuvio's server")

// SetHomeLayout replaces a profile's home layout: its rows, in the order
// given. Like the addon list it changes only while the profile is unlocked,
// and with the parent PIN for a kids profile.
func (s *Service) SetHomeLayout(ctx context.Context, profileID uint64, layout store.HomeLayout) error {
	return s.editAddons(profileID, func(db *store.Store) error {
		profile, err := db.Profile(profileID)
		if err != nil {
			return err
		}
		if profile.NuvioIndex != nil && !s.customServer() {
			return ErrHomeFromNuvio
		}
		return db.SetHomeLayout(profileID, layout)
	})
}
