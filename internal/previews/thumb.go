package previews

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
)

// thumbOf encodes img as the thumbnail the seek bar shows. Quality 70 puts a
// 320-pixel keyframe at about 10 KB, small enough to send as a data URL with
// every event and to keep the whole film's cache in memory.
func thumbOf(at float64, img *image.NRGBA) (Thumb, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 70}); err != nil {
		return Thumb{}, fmt.Errorf("previews: encode the frame at %.0fs: %w", at, err)
	}
	b := img.Bounds()
	return Thumb{
		At:  at,
		URL: "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()),
		W:   b.Dx(),
		H:   b.Dy(),
	}, nil
}
