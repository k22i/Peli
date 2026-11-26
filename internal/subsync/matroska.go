package subsync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
)

// Reading a Matroska file's subtitle timing without reading its clusters:
// the EBML header, the SeekHead, Info, Tracks and Cues, in a few range
// reads. mkvmerge indexes every subtitle frame in Cues (video gets its
// keyframes only), so a remux gives the whole film's subtitle timing
// (docs/spikes/subtitle-autosync.md: 3 reads, 0.5–3.5 MB).

const (
	idEBML        = 0x1A45DFA3
	idSegment     = 0x18538067
	idSeekHead    = 0x114D9B74
	idSeek        = 0x4DBB
	idSeekID      = 0x53AB
	idSeekPos     = 0x53AC
	idInfo        = 0x1549A966
	idTimeScale   = 0x2AD7B1
	idTracks      = 0x1654AE6B
	idTrackEntry  = 0xAE
	idTrackNumber = 0xD7
	idTrackType   = 0x83
	idCodecID     = 0x86
	idLanguage    = 0x22B59C
	idLangIETF    = 0x22B59D
	idFlagForced  = 0x55AA
	idCues        = 0x1C53BB6B
	idCuePoint    = 0xBB
	idCueTime     = 0xB3
	idCueTrackPos = 0xB7
	idCueTrack    = 0xF7
	idCluster     = 0x1F43B675

	trackTypeSubtitle = 17
	unknownSize       = -1

	headRead     = 512 << 10
	tailRead     = 4 << 20
	maxElement   = 16 << 20
	maxSeekHops  = 4
	headerRead   = 64 << 10
	defaultScale = 1_000_000 // ns per tick
)

// errNotMatroska: the file isn't Matroska or WebM.
var errNotMatroska = errors.New("subsync: not a Matroska file")

// ranges reads a resource by byte ranges.
type ranges interface {
	// ReadAt returns up to n bytes from off; fewer at the end.
	ReadAt(ctx context.Context, off, n int64) ([]byte, error)
	// Size is the resource's size, once a read has told it (0 before).
	Size() int64
}

type element struct {
	id      uint64
	size    int64 // unknownSize when the file doesn't say
	dataOff int64 // absolute offset of the data
	hdrLen  int
}

// vint reads an EBML variable-length integer. keepMarker keeps the length
// marker (element IDs); without it the marker is stripped (sizes), and
// all ones means unknown (math.MaxUint64).
func vint(b []byte, keepMarker bool) (uint64, int, error) {
	if len(b) == 0 {
		return 0, 0, io.ErrUnexpectedEOF
	}
	n := 1
	for mask := byte(0x80); n <= 8 && b[0]&mask == 0; mask >>= 1 {
		n++
	}
	if n > 8 {
		return 0, 0, errors.New("subsync: bad EBML integer")
	}
	if len(b) < n {
		return 0, 0, io.ErrUnexpectedEOF
	}
	v := uint64(b[0])
	if !keepMarker {
		v = uint64(b[0] & (0xFF >> n))
	}
	ones := v == uint64(0xFF>>n)
	for i := 1; i < n; i++ {
		v = v<<8 | uint64(b[i])
		ones = ones && b[i] == 0xFF
	}
	if !keepMarker && ones {
		return math.MaxUint64, n, nil
	}
	return v, n, nil
}

func readElement(b []byte, abs int64) (element, error) {
	id, n1, err := vint(b, true)
	if err != nil {
		return element{}, err
	}
	size, n2, err := vint(b[n1:], false)
	if err != nil {
		return element{}, err
	}
	e := element{id: id, size: int64(size), dataOff: abs + int64(n1+n2), hdrLen: n1 + n2}
	if size == math.MaxUint64 || size > math.MaxInt64/2 {
		e.size = unknownSize
	}
	return e, nil
}

// children calls fn with each element in data (at absolute offset abs) and
// its body, cut short if data ends first. fn returns false to stop.
func children(data []byte, abs int64, fn func(e element, body []byte) bool) {
	for off := 0; off < len(data); {
		e, err := readElement(data[off:], abs+int64(off))
		if err != nil {
			return
		}
		start := off + e.hdrLen
		end := len(data)
		if e.size != unknownSize && int64(start)+e.size <= int64(len(data)) {
			end = start + int(e.size)
		}
		if !fn(e, data[start:end]) || e.size == unknownSize {
			return
		}
		off = start + int(e.size)
	}
}

func uintOf(b []byte) uint64 {
	if len(b) > 8 {
		return 0
	}
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v
}

func stringOf(b []byte) string { return strings.TrimRight(string(b), "\x00") }

// loadMatroska reads the subtitle tracks of the Matroska file r and the
// times of their indexed packets.
func loadMatroska(ctx context.Context, r ranges) (*Reference, error) {
	head, err := r.ReadAt(ctx, 0, headRead)
	if err != nil {
		return nil, err
	}
	ebml, err := readElement(head, 0)
	if err != nil || ebml.id != idEBML || ebml.size == unknownSize || ebml.dataOff+ebml.size >= int64(len(head)) {
		return nil, errNotMatroska
	}
	segOff := ebml.dataOff + ebml.size
	seg, err := readElement(head[segOff:], segOff)
	if err != nil || seg.id != idSegment {
		return nil, errNotMatroska
	}
	segData := seg.dataOff
	pos := map[uint64]int64{} // element id → absolute offset of its header
	var more []int64          // further SeekHeads
	var infoBody, tracksBody, cuesBody []byte
	children(head[segData:], segData, func(e element, body []byte) bool {
		whole := e.size != unknownSize && int64(len(body)) == e.size
		switch e.id {
		case idSeekHead:
			seekHead(body, segData, pos, &more)
		case idInfo:
			if whole {
				infoBody = body
			}
		case idTracks:
			if whole {
				tracksBody = body
			}
		case idCues:
			if whole {
				cuesBody = body
			}
		case idCluster:
			return false
		}
		return true
	})
	for hop := 0; hop < maxSeekHops && len(more) > 0; hop++ {
		at := more[0]
		more = more[1:]
		if body, err := fetchElement(ctx, r, at); err == nil {
			seekHead(body, segData, pos, &more)
		}
	}

	if infoBody == nil {
		if at, ok := pos[idInfo]; ok {
			infoBody, _ = fetchElement(ctx, r, at)
		}
	}
	scale := uint64(defaultScale)
	children(infoBody, 0, func(e element, body []byte) bool {
		if e.id == idTimeScale {
			if v := uintOf(body); v > 0 {
				scale = v
			}
		}
		return true
	})
	if tracksBody == nil {
		at, ok := pos[idTracks]
		if !ok {
			return nil, fmt.Errorf("%w: no track list", ErrNoReference)
		}
		if tracksBody, err = fetchElement(ctx, r, at); err != nil {
			return nil, err
		}
	}
	tracks := subtitleTracks(tracksBody)
	if len(tracks) == 0 {
		return nil, fmt.Errorf("%w: no subtitle tracks", ErrNoReference)
	}
	if cuesBody == nil {
		if at, ok := pos[idCues]; ok {
			if cuesBody, err = fetchElement(ctx, r, at); err != nil {
				return nil, err
			}
		} else if cuesBody, err = tailCues(ctx, r); err != nil {
			return nil, err
		}
	}
	readCues(cuesBody, float64(scale)/1e6, tracks)
	ref := &Reference{}
	// The tracks come out in the file's order (by track number), not the
	// random order of the map: callers pick a reference track by position.
	numbers := make([]uint64, 0, len(tracks))
	for number := range tracks {
		numbers = append(numbers, number)
	}
	sort.Slice(numbers, func(i, j int) bool { return numbers[i] < numbers[j] })
	for _, number := range numbers {
		t := tracks[number]
		if len(t.Times) > 0 {
			sort.Slice(t.Times, func(i, j int) bool { return t.Times[i] < t.Times[j] })
			ref.Tracks = append(ref.Tracks, *t)
		}
	}
	if len(ref.Tracks) == 0 {
		return nil, fmt.Errorf("%w: subtitles not indexed", ErrNoReference)
	}
	return ref, nil
}

// fetchElement reads the element whose header is at abs: its header and
// what follows, then the rest of its body if it's longer.
func fetchElement(ctx context.Context, r ranges, abs int64) ([]byte, error) {
	hdr, err := r.ReadAt(ctx, abs, headerRead)
	if err != nil {
		return nil, err
	}
	e, err := readElement(hdr, abs)
	if err != nil {
		return nil, err
	}
	if e.size == unknownSize || e.size > maxElement {
		return nil, fmt.Errorf("subsync: element %x of %d bytes", e.id, e.size)
	}
	body := hdr[e.hdrLen:]
	if int64(len(body)) >= e.size {
		return body[:e.size], nil
	}
	rest, err := r.ReadAt(ctx, abs+int64(len(hdr)), e.size-int64(len(body)))
	if err != nil {
		return nil, err
	}
	body = append(body, rest...)
	if int64(len(body)) < e.size {
		return nil, io.ErrUnexpectedEOF
	}
	return body, nil
}

// tailCues looks for Cues in the last few MB, for files whose SeekHead
// doesn't point to them.
func tailCues(ctx context.Context, r ranges) ([]byte, error) {
	size := r.Size()
	if size <= 0 {
		return nil, fmt.Errorf("%w: no index", ErrNoReference)
	}
	off := max(size-tailRead, 0)
	tail, err := r.ReadAt(ctx, off, size-off)
	if err != nil {
		return nil, err
	}
	id := []byte{0x1C, 0x53, 0xBB, 0x6B}
	for i := bytes.LastIndex(tail, id); i >= 0; i = bytes.LastIndex(tail[:i], id) {
		e, err := readElement(tail[i:], off+int64(i))
		if err == nil && e.size > 0 && int64(i+e.hdrLen)+e.size <= int64(len(tail)) {
			return tail[i+e.hdrLen : int64(i+e.hdrLen)+e.size], nil
		}
	}
	return nil, fmt.Errorf("%w: no index", ErrNoReference)
}

func seekHead(body []byte, segData int64, pos map[uint64]int64, more *[]int64) {
	children(body, 0, func(e element, seek []byte) bool {
		if e.id != idSeek {
			return true
		}
		var id uint64
		at := int64(-1)
		children(seek, 0, func(c element, b []byte) bool {
			switch c.id {
			case idSeekID:
				id = uintOf(b)
			case idSeekPos:
				at = int64(uintOf(b))
			}
			return true
		})
		switch {
		case at < 0:
		case id == idSeekHead:
			*more = append(*more, segData+at)
		default:
			if _, ok := pos[id]; !ok {
				pos[id] = segData + at
			}
		}
		return true
	})
}

func subtitleTracks(body []byte) map[uint64]*Track {
	out := map[uint64]*Track{}
	children(body, 0, func(e element, entry []byte) bool {
		if e.id != idTrackEntry {
			return true
		}
		var number, kind uint64
		// Matroska's default language is English; the IETF tag wins over
		// the old ISO 639-2 one.
		var t Track
		lang, ietf := "eng", ""
		children(entry, 0, func(c element, b []byte) bool {
			switch c.id {
			case idTrackNumber:
				number = uintOf(b)
			case idTrackType:
				kind = uintOf(b)
			case idCodecID:
				t.Picture = pictureCodec(stringOf(b))
			case idLanguage:
				lang = stringOf(b)
			case idLangIETF:
				ietf = stringOf(b)
			case idFlagForced:
				t.Forced = uintOf(b) == 1
			}
			return true
		})
		t.Language = lang
		if ietf != "" {
			t.Language = ietf
		}
		if kind == trackTypeSubtitle && number > 0 {
			out[number] = &t
		}
		return true
	})
	return out
}

func pictureCodec(codec string) bool {
	return codec == "S_HDMV/PGS" || codec == "S_VOBSUB" || codec == "S_DVBSUB"
}

func readCues(body []byte, msPerTick float64, tracks map[uint64]*Track) {
	children(body, 0, func(e element, point []byte) bool {
		if e.id != idCuePoint {
			return true
		}
		var tick uint64
		var on []uint64
		children(point, 0, func(c element, b []byte) bool {
			switch c.id {
			case idCueTime:
				tick = uintOf(b)
			case idCueTrackPos:
				children(b, 0, func(d element, db []byte) bool {
					if d.id == idCueTrack {
						on = append(on, uintOf(db))
					}
					return true
				})
			}
			return true
		})
		for _, number := range on {
			if t := tracks[number]; t != nil {
				t.Times = append(t.Times, int64(float64(tick)*msPerTick))
			}
		}
		return true
	})
}
