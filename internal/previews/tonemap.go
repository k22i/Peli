package previews

import (
	"image"
	"math"
)

// toneMap turns a PQ or HLG frame (BT.2020 RGB, as screenshot-raw hands it
// over: converted from YUV but still in the HDR transfer) into SDR sRGB in
// place. A thumbnail needs "looks right", not accuracy: BT.2390-ish roll-off
// is overkill, an extended Reinhard on luminance does. Alpha is left at 255.
func toneMap(img *image.NRGBA, gamma, primaries string) {
	var lut [256]float64 // code value → linear, 1.0 = SDR reference white (203 nits)
	for i := range lut {
		v := float64(i) / 255
		if gamma == "pq" {
			lut[i] = pqEOTF(v) * 10000 / 203
		} else {
			lut[i] = hlgInvOETF(v) * 1000 / 203
		}
	}
	const peak = 1000.0 / 203 // maps to white
	bt2020 := primaries == "bt.2020"
	pix := img.Pix
	for i := 0; i+3 < len(pix); i += 4 {
		r, g, b := lut[pix[i]], lut[pix[i+1]], lut[pix[i+2]]
		if bt2020 {
			r, g, b = 1.6605*r-0.5876*g-0.0728*b,
				-0.1246*r+1.1329*g-0.0083*b,
				-0.0182*r-0.1006*g+1.1187*b
		}
		y := 0.2126*r + 0.7152*g + 0.0722*b
		if y > 0 {
			k := (1 + y/(peak*peak)) / (1 + y)
			r, g, b = r*k, g*k, b*k
		}
		pix[i], pix[i+1], pix[i+2] = srgb(r), srgb(g), srgb(b)
	}
}

// pqEOTF is the PQ transfer's inverse: code value to linear light, where 1
// is 10,000 nits.
func pqEOTF(e float64) float64 {
	const m1, m2 = 0.1593017578125, 78.84375
	const c1, c2, c3 = 0.8359375, 18.8515625, 18.6875
	p := math.Pow(e, 1/m2)
	return math.Pow(math.Max(p-c1, 0)/(c2-c3*p), 1/m1)
}

// hlgInvOETF is HLG's inverse OETF: code value to linear light, where 1 is
// 1,000 nits.
func hlgInvOETF(e float64) float64 {
	const a, b, c = 0.17883277, 0.28466892, 0.55991073
	if e <= 0.5 {
		return e * e / 3
	}
	return (math.Exp((e-c)/a) + b) / 12
}

// srgb is linear light to an 8-bit sRGB code value.
func srgb(v float64) uint8 {
	v = math.Max(0, math.Min(1, v))
	if v <= 0.0031308 {
		v *= 12.92
	} else {
		v = 1.055*math.Pow(v, 1/2.4) - 0.055
	}
	return uint8(v*255 + 0.5)
}
