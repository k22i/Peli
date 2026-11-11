package backend

import (
	"context"
	"time"

	"github.com/k22i/Peli/internal/nuvio"
)

// Remote is the account side of a Nuvio backend: what signing in, keeping a
// session and managing profiles need. internal/account depends on it, not
// on the client, so the backend can be swapped for a test's.
//
// The types are Nuvio's. Only Nuvio has accounts: a local-only profile has
// none of this, and a custom server (#34) speaks Nuvio's protocol, so the
// same *nuvio.Client is pointed at it (UseServer).
type Remote interface {
	// Auth.
	SignInWithPassword(ctx context.Context, email, password string) (nuvio.Session, error)
	Refresh(ctx context.Context, refreshToken string) (nuvio.Session, error)
	SignOut(ctx context.Context, s nuvio.Session) error
	StartDeviceLogin(ctx context.Context, linkURL, deviceName string) (nuvio.DeviceLogin, error)
	PollDeviceLogin(ctx context.Context, login nuvio.DeviceLogin) (status string, interval time.Duration, err error)
	ExchangeDeviceLogin(ctx context.Context, login nuvio.DeviceLogin) (nuvio.Session, error)

	// Profiles, their PINs and avatars.
	Profiles(ctx context.Context, s nuvio.Session) ([]nuvio.Profile, error)
	ProfileLocks(ctx context.Context, s nuvio.Session) ([]nuvio.ProfileLock, error)
	PatchProfile(ctx context.Context, s nuvio.Session, index int, patch nuvio.ProfilePatch) (nuvio.Profile, error)
	PushProfiles(ctx context.Context, s nuvio.Session, profiles []nuvio.Profile) error
	DeleteProfile(ctx context.Context, s nuvio.Session, index int) error
	VerifyProfilePIN(ctx context.Context, s nuvio.Session, index int, pin string) (nuvio.VerifyProfilePINResult, error)
	SetProfilePIN(ctx context.Context, s nuvio.Session, index int, pin, currentPin string) error
	ClearProfilePIN(ctx context.Context, s nuvio.Session, index int, currentPin string) error
	AvatarCatalog(ctx context.Context) ([]nuvio.Avatar, error)
	AvatarImageURL(a nuvio.Avatar) string

	// Which backend: Nuvio's or the user's own (#34).
	ServerURL() string
	UseServer(baseURL, key string)
	CheckServer(ctx context.Context, baseURL, key string) error
}

var _ Remote = (*nuvio.Client)(nil)
