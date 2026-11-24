//go:build !ios

package player

import (
	"context"

	"github.com/k22i/Peli/internal/previews"
	"github.com/k22i/Peli/internal/streams"
)

// OpenPreview opens a headless libmpv on source for seek-bar thumbnails
// (previews.Opener; docs/spikes/seek-previews.md).
func OpenPreview(ctx context.Context, source streams.Source, userAgent string) (previews.Grabber, error) {
	return nil, previews.ErrUnavailable // TODO(grabber worker)
}
