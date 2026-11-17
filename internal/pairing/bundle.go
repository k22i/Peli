// Package pairing copies SIMKL, AniList and the TMDB key from one device to
// another (#133, ADR-0061): the sender builds a bundle of the chosen
// profiles' grants, seals it for the receiver, and the receiver matches the
// profiles to its own and keeps the grants once the user confirms. Nothing
// passes through a server. No token is ever logged or handed to the
// webview: the frontend only sees names and which services are included.
package pairing

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/tracking"
)

// TmdbKey is the keychain key of the device-wide TMDB key (#47).
const TmdbKey = "tmdb.api-key"

// BundleVersion is the bundle layout this build writes and reads.
const BundleVersion = 1

var (
	// ErrWrongAccount means the two devices are signed in to different Nuvio
	// accounts (or one to none).
	ErrWrongAccount = errors.New("pairing: the devices are on different Nuvio accounts")
	// ErrNotSignedIn means this device has no Nuvio account to match on.
	ErrNotSignedIn = errors.New("pairing: not signed in to Nuvio")
	// ErrNothingToSend means no chosen profile has a connection, and the TMDB
	// key wasn't chosen or there is none.
	ErrNothingToSend = errors.New("pairing: nothing to send")
	// ErrBadBundle means the bundle isn't one this build understands.
	ErrBadBundle = errors.New("pairing: unreadable bundle")
)

// Bundle is what one pairing carries, as JSON before sealing.
type Bundle struct {
	Version   int             `json:"v"`
	Profiles  []BundleProfile `json:"profiles"`
	TmdbKey   string          `json:"tmdbKey,omitempty"`
	Sender    Device          `json:"sender"`
	CreatedAt int64           `json:"createdAt"`

	// The sender's own profile ids, in Profiles' order (never sent).
	from []uint64
}

// BundleProfile is one profile's grants. NuvioIndex is what matches it on
// the receiver; nil for a local-only profile (Guest).
type BundleProfile struct {
	NuvioIndex *int   `json:"nuvioIndex,omitempty"`
	Name       string `json:"name"`
	tracking.Grants
}

// Device names a device to the other: "Kevin's Mac", "macos".
type Device struct {
	Name     string `json:"deviceName"`
	Platform string `json:"platform"`
}

// AccountHash is what the QR (or the phrase path's first message) carries
// instead of the Nuvio user id: SHA-256 over a label and the id, the first
// 16 bytes.
func AccountHash(userID string) [16]byte {
	sum := sha256.Sum256([]byte("peli-pair v1 account\x00" + userID))
	var h [16]byte
	copy(h[:], sum[:16])
	return h
}

// Keychain is where the TMDB key is: *secrets.Keychain in the app.
type Keychain interface {
	Get(key string) (string, error)
	Set(key, value string) error
}

// Sources are what a sender builds from and a receiver applies to.
type Sources struct {
	Open     func() *store.Store
	Tracking *tracking.Service
	Keychain Keychain
	Now      func() time.Time
}

func (src Sources) now() time.Time {
	if src.Now != nil {
		return src.Now()
	}
	return time.Now()
}

// account returns this device's Nuvio user id.
func (src Sources) account() (string, error) {
	db := src.Open()
	if db == nil {
		return "", errors.New("pairing: store not open")
	}
	account, err := db.NuvioAccount()
	if err != nil {
		return "", err
	}
	if account == "" {
		return "", ErrNotSignedIn
	}
	return account, nil
}

// Shareable is a profile the sender can offer, for "Add to another device".
type Shareable struct {
	ProfileID uint64 `json:"profileId"`
	Name      string `json:"name"`
	// Which services it would send.
	Simkl   bool `json:"simkl"`
	AniList bool `json:"anilist"`
	// Local-only profiles (Guest) can be sent, but the receiver has to pick
	// a profile for them.
	LocalOnly bool `json:"localOnly"`
}

// Offer is what the sender's dialog starts from: every non-kids profile
// with a working connection (all of them ticked by default), and whether
// there's a TMDB key to send.
type Offer struct {
	Profiles []Shareable `json:"profiles"`
	TmdbKey  bool        `json:"tmdbKey"`
}

// MakeOffer lists what this device could send.
func MakeOffer(src Sources) (Offer, error) {
	db := src.Open()
	if db == nil {
		return Offer{}, errors.New("pairing: store not open")
	}
	profiles, err := db.Profiles()
	if err != nil {
		return Offer{}, err
	}
	offer := Offer{Profiles: []Shareable{}}
	for _, p := range profiles {
		if p.Kids {
			continue
		}
		c, err := src.Tracking.Status(p.ID)
		if err != nil {
			continue
		}
		simkl := c.Simkl != nil && !c.Simkl.NeedsReconnect
		ani := c.AniList != nil && !c.AniList.NeedsReconnect
		if !simkl && !ani {
			continue
		}
		offer.Profiles = append(offer.Profiles, Shareable{ProfileID: p.ID, Name: p.Name, Simkl: simkl, AniList: ani, LocalOnly: p.NuvioIndex == nil})
	}
	if key, err := src.Keychain.Get(TmdbKey); err == nil && key != "" {
		offer.TmdbKey = true
	}
	return offer, nil
}

// Choice is what the sender picked.
type Choice struct {
	ProfileIDs []uint64 `json:"profileIds"`
	TmdbKey    bool     `json:"tmdbKey"`
}

// Build makes the bundle for choice. Kids profiles and profiles with no
// working connection are left out; ErrNothingToSend if that leaves nothing.
func Build(ctx context.Context, src Sources, choice Choice, sender Device) (Bundle, error) {
	db := src.Open()
	if db == nil {
		return Bundle{}, errors.New("pairing: store not open")
	}
	b := Bundle{Version: BundleVersion, Profiles: []BundleProfile{}, Sender: sender, CreatedAt: src.now().UnixMilli()}
	for _, id := range choice.ProfileIDs {
		p, err := db.Profile(id)
		if err != nil {
			return Bundle{}, err
		}
		if p.Kids {
			continue
		}
		g, err := tracking.Export(ctx, src.Tracking, id)
		if errors.Is(err, tracking.ErrKidsProfile) {
			continue
		}
		if err != nil {
			return Bundle{}, fmt.Errorf("pairing: %s's connections: %w", p.Name, err)
		}
		if g.Empty() {
			continue
		}
		b.Profiles = append(b.Profiles, BundleProfile{NuvioIndex: p.NuvioIndex, Name: p.Name, Grants: g})
		b.from = append(b.from, id)
	}
	if choice.TmdbKey {
		key, err := src.Keychain.Get(TmdbKey)
		if err != nil && !errors.Is(err, secrets.ErrNotFound) {
			return Bundle{}, err
		}
		b.TmdbKey = key
	}
	if len(b.Profiles) == 0 && b.TmdbKey == "" {
		return Bundle{}, ErrNothingToSend
	}
	return b, nil
}

// Check refuses a bundle this build can't apply.
func (b Bundle) Check() error {
	if b.Version != BundleVersion {
		return fmt.Errorf("%w: version %d", ErrBadBundle, b.Version)
	}
	for _, p := range b.Profiles {
		if s := p.Simkl; s != nil && (s.Access == "" || s.Refresh == "") {
			return fmt.Errorf("%w: a SIMKL grant has no token", ErrBadBundle)
		}
		if a := p.AniList; a != nil && a.Token == "" {
			return fmt.Errorf("%w: an AniList grant has no token", ErrBadBundle)
		}
	}
	return nil
}

// --- the receiver: matching and applying ------------------------------------

// Summary is what the receiver shows before it keeps anything: "SIMKL and
// AniList for Kevin, TMDB key". It names no token.
type Summary struct {
	Sender   Device         `json:"sender"`
	Profiles []ProfileMatch `json:"profiles"`
	TmdbKey  bool           `json:"tmdbKey"`
	// This device already has a TMDB key, which the bundle's would replace.
	ReplacesTmdbKey bool `json:"replacesTmdbKey"`
}

// ProfileMatch is one sent profile and where it goes here.
type ProfileMatch struct {
	// Index is the profile's place in the bundle; Decisions name it.
	Index int    `json:"index"`
	Name  string `json:"name"`
	// The accounts it carries, by user name; "" for none.
	SimklUser   string `json:"simklUser"`
	AniListUser string `json:"anilistUser"`
	// Target is the local profile it matched by Nuvio index, or 0 for none:
	// the user then picks one of Choices, or skips it.
	Target     uint64 `json:"target"`
	TargetName string `json:"targetName"`
	// Choices are the local non-kids profiles the user may send it to.
	Choices []Target `json:"choices"`
	// Which of the target's own connections the grants would replace.
	ReplacesSimkl   bool `json:"replacesSimkl"`
	ReplacesAniList bool `json:"replacesAnilist"`
}

// Target is a local profile a sent one can go to.
type Target struct {
	ProfileID uint64 `json:"profileId"`
	Name      string `json:"name"`
	// The services it's connected to already.
	Simkl   bool `json:"simkl"`
	AniList bool `json:"anilist"`
}

// Match pairs b's profiles with this device's by Nuvio index. Kids profiles
// are never targets; Guest and other local-only profiles are only choices.
func Match(src Sources, b Bundle) (Summary, error) {
	db := src.Open()
	if db == nil {
		return Summary{}, errors.New("pairing: store not open")
	}
	locals, err := db.Profiles()
	if err != nil {
		return Summary{}, err
	}
	var targets []Target
	byIndex := map[int]Target{}
	for _, p := range locals {
		if p.Kids {
			continue
		}
		t := Target{ProfileID: p.ID, Name: p.Name}
		if c, err := src.Tracking.Status(p.ID); err == nil {
			t.Simkl, t.AniList = c.Simkl != nil, c.AniList != nil
		}
		targets = append(targets, t)
		if p.NuvioIndex != nil {
			byIndex[*p.NuvioIndex] = t
		}
	}
	s := Summary{Sender: b.Sender, Profiles: []ProfileMatch{}, TmdbKey: b.TmdbKey != ""}
	if key, err := src.Keychain.Get(TmdbKey); err == nil && key != "" && s.TmdbKey {
		s.ReplacesTmdbKey = key != b.TmdbKey
	}
	for i, p := range b.Profiles {
		m := ProfileMatch{Index: i, Name: p.Name, Choices: slices.Clone(targets)}
		if p.Simkl != nil {
			m.SimklUser = p.Simkl.User
		}
		if p.AniList != nil {
			m.AniListUser = p.AniList.User
		}
		if p.NuvioIndex != nil {
			if t, ok := byIndex[*p.NuvioIndex]; ok {
				m.Target, m.TargetName = t.ProfileID, t.Name
				m.ReplacesSimkl = p.Simkl != nil && t.Simkl
				m.ReplacesAniList = p.AniList != nil && t.AniList
			}
		}
		if m.Choices == nil {
			m.Choices = []Target{}
		}
		s.Profiles = append(s.Profiles, m)
	}
	return s, nil
}

// Decisions are what the user confirmed on the summary.
type Decisions struct {
	// Targets maps a bundle profile's Index to the local profile it goes to;
	// a profile left out (or 0) is skipped.
	Targets map[int]uint64 `json:"targets"`
	TmdbKey bool           `json:"tmdbKey"`
}

// Applied is what was kept, for the toast: "Connected SIMKL and AniList
// from Kevin's Mac".
type Applied struct {
	Sender   Device   `json:"sender"`
	Profiles []uint64 `json:"profiles"`
	Simkl    bool     `json:"simkl"`
	AniList  bool     `json:"anilist"`
	TmdbKey  bool     `json:"tmdbKey"`
}

// Apply keeps b's grants as d says, marked shared with the sender. Kids
// profiles are refused even if named. Two bundle profiles may not go to
// the same local one.
func Apply(src Sources, b Bundle, d Decisions) (Applied, error) {
	if err := b.Check(); err != nil {
		return Applied{}, err
	}
	db := src.Open()
	if db == nil {
		return Applied{}, errors.New("pairing: store not open")
	}
	done := Applied{Sender: b.Sender, Profiles: []uint64{}}
	used := map[uint64]bool{}
	for i, p := range b.Profiles {
		target := d.Targets[i]
		if target == 0 || p.Empty() {
			continue
		}
		if used[target] {
			return done, fmt.Errorf("pairing: two profiles chose the same profile here")
		}
		used[target] = true
		local, err := db.Profile(target)
		if err != nil {
			return done, err
		}
		if local.Kids {
			return done, tracking.ErrKidsProfile
		}
		if err := tracking.Adopt(src.Tracking, target, p.Grants, b.Sender.Name); err != nil {
			return done, fmt.Errorf("pairing: %s: %w", local.Name, err)
		}
		done.Profiles = append(done.Profiles, target)
		done.Simkl = done.Simkl || p.Simkl != nil
		done.AniList = done.AniList || p.AniList != nil
	}
	if d.TmdbKey && b.TmdbKey != "" {
		if err := src.Keychain.Set(TmdbKey, b.TmdbKey); err != nil {
			return done, err
		}
		done.TmdbKey = true
	}
	return done, nil
}

// MarkSent notes on the sender that b's grants went to the device named to.
// b is the bundle Build returned.
func MarkSent(src Sources, b Bundle, to string) {
	for i, p := range b.Profiles {
		if i < len(b.from) {
			_ = tracking.MarkShared(src.Tracking, b.from[i], p.Grants, to)
		}
	}
}
