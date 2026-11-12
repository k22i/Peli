package updates

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"io"

	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/endpoint"
)

// FeedURL is where Peli looks for a newer release: the feed `tools/updates
// feed` writes, attached to the latest GitHub release. A build can point it
// elsewhere with -ldflags "-X github.com/k22i/Peli/internal/updates.FeedURL=…",
// and $PELI_UPDATE_URL overrides it at run time (for trying an update locally).
var FeedURL = "https://github.com/k22i/Peli/releases/latest/download/" + FeedName

// FeedName is the feed's file name on a release.
const FeedName = "peli-update.json"

// PublicKey verifies every update (ADR-0054): an Ed25519 key, base64. Its
// private half signs releases (PELI_UPDATE_KEY, in the login keychain as
// "Peli update signing" and in CI's secrets). Changing it means shipping one
// release signed with the old key whose app trusts the new one. Empty, updates
// stay off.
const PublicKey = ""

// SignatureAlgo is how releases are signed: Ed25519ph over the artifact's
// SHA-512, which the updater computes while the file downloads.
const SignatureAlgo = "ed25519ph"

// Feed is the manifest a release publishes, in the shape Wails' endpoint
// provider reads.
type Feed struct {
	SchemaVersion int        `json:"schemaVersion"`
	Version       string     `json:"version"`
	Name          string     `json:"name,omitempty"`
	Notes         string     `json:"notes,omitempty"`
	PublishedAt   string     `json:"publishedAt,omitempty"`
	Artifacts     []Artifact `json:"artifacts"`
}

// Artifact is one platform's download: on macOS, a zip holding Peli.app.
type Artifact struct {
	URL           string `json:"url"`
	Platform      string `json:"platform"`
	Arch          string `json:"arch"`
	Size          int64  `json:"size"`
	SignatureAlgo string `json:"signatureAlgo"`
	Signature     string `json:"signature"`
}

// MaxArtifact is the largest download Peli accepts: ADR-0005's 60 MB limit
// is for the DMG, and the zip of the same app is a little bigger.
const MaxArtifact = 150 << 20

// ErrUnsigned means the feed offered a release without Peli's signature.
var ErrUnsigned = errors.New("updates: release isn't signed")

// publicKey decodes PublicKey: nil while it's empty.
func publicKey() ed25519.PublicKey {
	if PublicKey == "" {
		return nil
	}
	key, err := base64.StdEncoding.DecodeString(PublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		panic("updates: PublicKey isn't a base64 Ed25519 key")
	}
	return key
}

// signed is the feed's provider with Peli's rule on top: a release must be
// signed. Wails' updater accepts a release with only a digest, or with
// nothing at all, and verifies a signature only when the feed has one.
type signed struct {
	feed updater.Provider
}

func newProvider(url, userAgent string) (updater.Provider, error) {
	feed, err := endpoint.New(endpoint.Config{
		URL:     url,
		Headers: map[string]string{"User-Agent": userAgent},
	})
	if err != nil {
		return nil, err
	}
	return signed{feed}, nil
}

func (p signed) Name() string { return "peli" }

func (p signed) Check(ctx context.Context, req updater.CheckRequest) (*updater.Release, error) {
	rel, err := p.feed.Check(ctx, req)
	if err != nil || rel == nil {
		return rel, err
	}
	v := rel.Verification
	if v == nil || v.SignatureAlgo != SignatureAlgo || len(v.Signature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("%w: %s for %s/%s", ErrUnsigned, rel.Version, req.Platform, req.Arch)
	}
	if rel.Artifact.Size <= 0 || rel.Artifact.Size > MaxArtifact {
		return nil, fmt.Errorf("updates: %s's download is %d bytes", rel.Version, rel.Artifact.Size)
	}
	return rel, nil
}

// Download stops at the size the feed gave, so a server can't fill the disk.
func (p signed) Download(ctx context.Context, rel *updater.Release, dst io.Writer, progress func(written, total int64)) error {
	return p.feed.Download(ctx, rel, &capped{w: dst, left: rel.Artifact.Size}, progress)
}

type capped struct {
	w    io.Writer
	left int64
}

func (c *capped) Write(b []byte) (int, error) {
	if int64(len(b)) > c.left {
		return 0, errors.New("updates: download is bigger than the feed said")
	}
	c.left -= int64(len(b))
	return c.w.Write(b)
}
