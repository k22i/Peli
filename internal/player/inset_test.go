package player

import (
	"math"
	"testing"
)

func TestInsetRatio(t *testing.T) {
	for _, c := range []struct {
		right, width int
		want         float64
	}{
		{352, 1408, 0.25},
		{352, 0, 0},    // width unknown
		{0, 1000, 0},   // no inset
		{-10, 1000, 0}, // nonsense
		{800, 1000, maxInsetRatio},
		{1000, 1000, maxInsetRatio},
	} {
		if got := insetRatio(c.right, c.width); math.Abs(got-c.want) > 1e-9 {
			t.Errorf("insetRatio(%d, %d) = %v, want %v", c.right, c.width, got, c.want)
		}
	}
}
