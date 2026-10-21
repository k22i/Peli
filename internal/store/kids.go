package store

import (
	"errors"
	"fmt"
	"slices"

	bolt "go.etcd.io/bbolt"
)

// ErrKidsProfile means the change would leave a kids profile (#26). Leaving
// asks for the parent PIN, which only the account service can check, so the
// store's own shortcuts for switching refuse instead.
var ErrKidsProfile = errors.New("store: a kids profile can only be left with the parent PIN")

// CatalogRef names one catalog of an addon, as a Stremio manifest does: the
// addon by its manifest URL, then the catalog's type ("movie", "series") and
// id ("top").
type CatalogRef struct {
	Addon string `json:"addon"`
	Type  string `json:"type"`
	ID    string `json:"id"`
}

// KidsScope is what a kids profile may see, chosen by the parent (#26). It is
// an allow-list, so what isn't named is hidden: an addon installed later, or
// a catalog an addon adds, stays out until the parent picks it. A profile
// that isn't a kids profile ignores its scope.
type KidsScope struct {
	// The addons, by manifest URL, whose catalogs the profile browses and
	// whose results its search shows.
	Addons []string `json:"addons"`
	// Narrows an addon to some of its catalogs. An allowed addon with none
	// listed here shows all its catalogs.
	Catalogs []CatalogRef `json:"catalogs"`
}

// AllowsAddon reports whether the scope lets the profile use the addon at
// manifest URL addon.
func (k KidsScope) AllowsAddon(addon string) bool { return slices.Contains(k.Addons, addon) }

// AllowsCatalog reports whether the scope lets the profile browse a catalog.
func (k KidsScope) AllowsCatalog(addon, contentType, id string) bool {
	if !k.AllowsAddon(addon) {
		return false
	}
	narrowed := false
	for _, c := range k.Catalogs {
		if c.Addon != addon {
			continue
		}
		if c.Type == contentType && c.ID == id {
			return true
		}
		narrowed = true
	}
	return !narrowed
}

// KidsScope returns profile id's kids scope: nothing allowed until the
// parent chooses.
func (s *Store) KidsScope(id uint64) (KidsScope, error) {
	scope := KidsScope{Addons: []string{}, Catalogs: []CatalogRef{}}
	err := s.view(id, func(p *bolt.Bucket) error {
		return decodeOnto(p.Get(keyKids), &scope)
	})
	return scope, err
}

// SetKidsScope replaces profile id's kids scope. It is kept on this device
// only: Nuvio has no kids profiles to sync it with. A catalog must belong to
// an allowed addon.
func (s *Store) SetKidsScope(id uint64, scope KidsScope) error {
	scope = KidsScope{Addons: orEmpty(scope.Addons), Catalogs: orEmpty(scope.Catalogs)}
	seen := map[string]bool{}
	for _, addon := range scope.Addons {
		if addon == "" || seen[addon] {
			return fmt.Errorf("%w: addon %q is empty or listed twice", ErrInvalidItem, addon)
		}
		seen[addon] = true
	}
	for _, c := range scope.Catalogs {
		if c.Type == "" || c.ID == "" || !seen[c.Addon] {
			return fmt.Errorf("%w: catalog %s/%s needs a type, an id and an allowed addon", ErrInvalidItem, c.Type, c.ID)
		}
	}
	return s.update(id, func(p *bolt.Bucket) error { return put(p, keyKids, scope) })
}

func orEmpty[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}

// VisibleAddons returns the enabled addons profile id may browse and search,
// in order: all of them, or for a kids profile only those its scope allows.
// Home, browse, search and title pages (#42–#45) ask here rather than for
// Addons, so a kids profile can't see another addon's catalogs or results.
// Streams and subtitles come after a title was chosen from an allowed
// catalog, so they aren't limited.
func (s *Store) VisibleAddons(id uint64) ([]Addon, error) {
	profile, err := s.Profile(id)
	if err != nil {
		return nil, err
	}
	addons, err := s.Addons(id)
	if err != nil {
		return nil, err
	}
	var scope KidsScope
	if profile.Kids {
		if scope, err = s.KidsScope(id); err != nil {
			return nil, err
		}
	}
	visible := []Addon{}
	for _, addon := range addons {
		if addon.Enabled && (!profile.Kids || scope.AllowsAddon(addon.URL)) {
			visible = append(visible, addon)
		}
	}
	return visible, nil
}

// CatalogVisible reports whether profile id may browse a catalog of an
// addon: any catalog of an enabled addon, or for a kids profile only one its
// scope allows.
func (s *Store) CatalogVisible(id uint64, addon, contentType, catalog string) (bool, error) {
	visible, err := s.VisibleAddons(id)
	if err != nil || !slices.ContainsFunc(visible, func(a Addon) bool { return a.URL == addon }) {
		return false, err
	}
	profile, err := s.Profile(id)
	if err != nil || !profile.Kids {
		return err == nil, err
	}
	scope, err := s.KidsScope(id)
	return scope.AllowsCatalog(addon, contentType, catalog), err
}

// currentIsKids reports whether the profile in use is a kids profile.
func (s *Store) currentIsKids() (bool, error) {
	current, _, err := s.ProfileInUse()
	return current.Kids, err
}
