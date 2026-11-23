package main

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"time"
)

// Matroska subtitle index loader: reads the EBML header, SeekHead, Info,
// Tracks and Cues of a remote .mkv with a handful of Range requests, and
// returns every subtitle packet's time per subtitle track. mkvmerge indexes
// every subtitle frame in Cues (video gets keyframes only), which is what
// makes this cheap: the whole film's subtitle timing without reading
// clusters.

const (
	idEBML        = 0x1A45DFA3
	idSegment     = 0x18538067
	idSeekHead    = 0x114D9B74
	idSeek        = 0x4DBB
	idSeekID      = 0x53AB
	idSeekPos     = 0x53AC
	idInfo        = 0x1549A966
	idTimeScale   = 0x2AD7B1
	idDuration    = 0x4489
	idTracks      = 0x1654AE6B
	idTrackEntry  = 0xAE
	idTrackNumber = 0xD7
	idTrackType   = 0x83
	idCodecID     = 0x86
	idLanguage    = 0x22B59C
	idLangIETF    = 0x22B59D
	idName        = 0x536E
	idFlagDefault = 0x88
	idFlagForced  = 0x55AA
	idFlagHI      = 0x55AB
	idEncodings   = 0x6D80
	idEncoding    = 0x6240
	idCompression = 0x5034
	idCompAlgo    = 0x4254
	idCompSetting = 0x4255
	idCues        = 0x1C53BB6B
	idCuePoint    = 0xBB
	idCueTime     = 0xB3
	idCueTrackPos = 0xB7
	idCueTrack    = 0xF7
	idCueCluster  = 0xF1
	idCueRelPos   = 0xF0
	idCueDuration = 0xB2
	idCluster     = 0x1F43B675
	idSimpleBlock = 0xA3
	idBlockGroup  = 0xA0
	idBlock       = 0xA1
	idBlockDur    = 0x9B

	trackTypeSubtitle = 17

	headProbe  = 512 << 10
	tailProbe  = 4 << 20
	maxCues    = 16 << 20
	maxTracks  = 4 << 20
	unknownLen = -1
)

type SubTrack struct {
	Number   uint64 `json:"number"`
	Codec    string `json:"codec"`
	Language string `json:"language"`
	Name     string `json:"name,omitempty"`
	Default  bool   `json:"default,omitempty"`
	Forced   bool   `json:"forced,omitempty"`
	HI       bool   `json:"hi,omitempty"`
	// Compression of the packets (for reading text): -1 none, 0 zlib, 3
	// header stripping.
	CompAlgo int    `json:"-"`
	CompHead []byte `json:"-"`

	Cues []IndexCue `json:"-"`
	// Filled in by the loader for the report.
	CueCount     int `json:"cue_count"`
	WithDuration int `json:"with_duration"`
}

// Text reports whether the track is text (its packets can be read as words).
func (t *SubTrack) Text() bool {
	return strings.HasPrefix(t.Codec, "S_TEXT/")
}

// Picture reports whether the track is a bitmap format (PGS, VobSub).
func (t *SubTrack) Picture() bool {
	return t.Codec == "S_HDMV/PGS" || t.Codec == "S_VOBSUB" || t.Codec == "S_DVBSUB"
}

type IndexCue struct {
	Ms         int64 // packet time
	DurMs      int64 // CueDuration, or -1
	ClusterPos int64 // relative to segment data
	RelPos     int64 // within the cluster's data, or -1
}

type MKVIndex struct {
	SegData    int64 // absolute offset of the segment's data
	TimeScale  uint64
	DurationMs int64
	Tracks     []*SubTrack
	// What it cost.
	Requests int
	Bytes    int64
	Elapsed  time.Duration
	// Which path found Cues: seekhead, tail, none.
	CuesVia string
}

type element struct {
	id      uint64
	size    int64 // unknownLen when unknown
	dataOff int64 // absolute
	hdrLen  int
}

// readVint reads an EBML variable-length integer. keepMarker leaves the
// length marker in (element IDs); without it the marker is stripped (sizes).
func readVint(b []byte, keepMarker bool) (uint64, int, error) {
	if len(b) == 0 {
		return 0, 0, io.ErrUnexpectedEOF
	}
	first := b[0]
	n := 1
	for mask := byte(0x80); n <= 8 && first&mask == 0; mask >>= 1 {
		n++
	}
	if n > 8 {
		return 0, 0, errors.New("bad vint")
	}
	if len(b) < n {
		return 0, 0, io.ErrUnexpectedEOF
	}
	var v uint64
	if keepMarker {
		v = uint64(first)
	} else {
		v = uint64(first & (0xFF >> n))
	}
	allOnes := v == uint64(0xFF>>n)
	for i := 1; i < n; i++ {
		v = v<<8 | uint64(b[i])
		if b[i] != 0xFF {
			allOnes = false
		}
	}
	if !keepMarker && allOnes {
		return math.MaxUint64, n, nil
	}
	return v, n, nil
}

// readElement parses an element header at b[0:], whose absolute offset is abs.
func readElement(b []byte, abs int64) (element, error) {
	id, n1, err := readVint(b, true)
	if err != nil {
		return element{}, err
	}
	size, n2, err := readVint(b[n1:], false)
	if err != nil {
		return element{}, err
	}
	e := element{id: id, dataOff: abs + int64(n1+n2), hdrLen: n1 + n2}
	if size == math.MaxUint64 {
		e.size = unknownLen
	} else {
		e.size = int64(size)
	}
	return e, nil
}

// children walks the elements inside data (whose absolute offset is abs).
func children(data []byte, abs int64, fn func(e element, body []byte) bool) {
	off := 0
	for off < len(data) {
		e, err := readElement(data[off:], abs+int64(off))
		if err != nil {
			return
		}
		start := off + e.hdrLen
		end := len(data)
		if e.size != unknownLen && start+int(e.size) <= len(data) {
			end = start + int(e.size)
		}
		if !fn(e, data[start:end]) {
			return
		}
		if e.size == unknownLen {
			return
		}
		off = start + int(e.size)
	}
}

func uintOf(b []byte) uint64 {
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v
}

func floatOf(b []byte) float64 {
	switch len(b) {
	case 4:
		return float64(math.Float32frombits(binary.BigEndian.Uint32(b)))
	case 8:
		return math.Float64frombits(binary.BigEndian.Uint64(b))
	}
	return 0
}

// LoadMKVIndex reads the subtitle tracks and their Cues.
func LoadMKVIndex(ctx context.Context, r *Ranged) (*MKVIndex, error) {
	start := time.Now()
	reqs0, bytes0 := r.Requests, r.Bytes
	defer func() {}()
	head, err := r.Read(ctx, 0, headProbe)
	if err != nil {
		return nil, err
	}
	ebml, err := readElement(head, 0)
	if err != nil || ebml.id != idEBML {
		return nil, errors.New("not EBML")
	}
	segOff := ebml.dataOff + ebml.size
	seg, err := readElement(head[segOff:], segOff)
	if err != nil || seg.id != idSegment {
		return nil, errors.New("no Segment")
	}
	idx := &MKVIndex{SegData: seg.dataOff, TimeScale: 1_000_000}
	pos := map[uint64]int64{} // top-level id → absolute offset
	var seekHeads []int64

	var tracksBody, infoBody []byte
	scanTop := func(data []byte, abs int64) {
		children(data, abs, func(e element, body []byte) bool {
			switch e.id {
			case idSeekHead:
				parseSeekHead(body, idx.SegData, pos, &seekHeads)
			case idInfo:
				if e.size != unknownLen && int64(len(body)) == e.size {
					infoBody = body
				}
			case idTracks:
				if e.size != unknownLen && int64(len(body)) == e.size {
					tracksBody = body
				}
			case idCues:
				if e.size != unknownLen && int64(len(body)) == e.size {
					pos[idCues] = e.dataOff - int64(e.hdrLen)
				}
			case idCluster:
				return false
			}
			return true
		})
	}
	scanTop(head[seg.dataOff:], seg.dataOff)

	// A SeekHead may point to another SeekHead (often at the end).
	for hop := 0; hop < 4 && len(seekHeads) > 0; hop++ {
		at := seekHeads[0]
		seekHeads = seekHeads[1:]
		if at < int64(len(head)) {
			continue
		}
		body, _, err := fetchElement(ctx, r, at, 2<<20)
		if err == nil {
			parseSeekHead(body, idx.SegData, pos, &seekHeads)
		}
	}

	if infoBody == nil {
		if at, ok := pos[idInfo]; ok {
			infoBody, _, _ = fetchElement(ctx, r, at, 1<<20)
		}
	}
	children(infoBody, 0, func(e element, body []byte) bool {
		switch e.id {
		case idTimeScale:
			idx.TimeScale = uintOf(body)
		case idDuration:
			idx.DurationMs = int64(floatOf(body) * float64(idx.TimeScale) / 1e6)
		}
		return true
	})
	if tracksBody == nil {
		at, ok := pos[idTracks]
		if !ok {
			return nil, errors.New("no Tracks")
		}
		tracksBody, _, err = fetchElement(ctx, r, at, maxTracks)
		if err != nil {
			return nil, fmt.Errorf("tracks: %w", err)
		}
	}
	idx.Tracks = parseTracks(tracksBody)
	if len(idx.Tracks) == 0 {
		idx.CuesVia = "no-subtitle-tracks"
		idx.finish(r, start, reqs0, bytes0)
		return idx, nil
	}

	var cuesBody []byte
	if at, ok := pos[idCues]; ok {
		idx.CuesVia = "seekhead"
		cuesBody, _, err = fetchElement(ctx, r, at, maxCues)
		if err != nil {
			return nil, fmt.Errorf("cues: %w", err)
		}
	} else {
		// No SeekHead entry: look for Cues in the tail.
		off, tail, err := r.Tail(ctx, tailProbe)
		if err == nil {
			for i := bytes.LastIndex(tail, []byte{0x1C, 0x53, 0xBB, 0x6B}); i >= 0; i = bytes.LastIndex(tail[:i], []byte{0x1C, 0x53, 0xBB, 0x6B}) {
				e, err := readElement(tail[i:], off+int64(i))
				if err == nil && e.size > 0 && i+e.hdrLen+int(e.size) <= len(tail) {
					cuesBody = tail[i+e.hdrLen : i+e.hdrLen+int(e.size)]
					idx.CuesVia = "tail"
					break
				}
			}
		}
		if cuesBody == nil {
			idx.CuesVia = "none"
		}
	}
	parseCues(cuesBody, idx)
	idx.finish(r, start, reqs0, bytes0)
	return idx, nil
}

func (idx *MKVIndex) finish(r *Ranged, start time.Time, reqs0 int, bytes0 int64) {
	idx.Requests = r.Requests - reqs0
	idx.Bytes = r.Bytes - bytes0
	idx.Elapsed = time.Since(start)
}

// fetchElement reads the element whose header is at abs: a small read for
// the header, then its body (capped).
func fetchElement(ctx context.Context, r *Ranged, abs int64, limit int64) ([]byte, element, error) {
	hdr, err := r.Read(ctx, abs, 64<<10)
	if err != nil {
		return nil, element{}, err
	}
	e, err := readElement(hdr, abs)
	if err != nil {
		return nil, e, err
	}
	if e.size == unknownLen || e.size > limit {
		return nil, e, fmt.Errorf("element %x too large (%d)", e.id, e.size)
	}
	have := int64(len(hdr) - e.hdrLen)
	if have >= e.size {
		return hdr[e.hdrLen : int64(e.hdrLen)+e.size], e, nil
	}
	rest, err := r.Read(ctx, abs+int64(len(hdr)), e.size-have)
	if err != nil {
		return nil, e, err
	}
	return append(hdr[e.hdrLen:], rest...), e, nil
}

func parseSeekHead(body []byte, segData int64, pos map[uint64]int64, more *[]int64) {
	children(body, 0, func(e element, seek []byte) bool {
		if e.id != idSeek {
			return true
		}
		var id uint64
		p := int64(-1)
		children(seek, 0, func(c element, b []byte) bool {
			switch c.id {
			case idSeekID:
				id = uintOf(b)
			case idSeekPos:
				p = int64(uintOf(b))
			}
			return true
		})
		if p < 0 {
			return true
		}
		if id == idSeekHead {
			*more = append(*more, segData+p)
		} else if _, ok := pos[id]; !ok {
			pos[id] = segData + p
		}
		return true
	})
}

func parseTracks(body []byte) []*SubTrack {
	var out []*SubTrack
	children(body, 0, func(e element, entry []byte) bool {
		if e.id != idTrackEntry {
			return true
		}
		t := &SubTrack{Language: "eng", Default: true, CompAlgo: -1}
		var typ uint64
		children(entry, 0, func(c element, b []byte) bool {
			switch c.id {
			case idTrackNumber:
				t.Number = uintOf(b)
			case idTrackType:
				typ = uintOf(b)
			case idCodecID:
				t.Codec = strings.TrimRight(string(b), "\x00")
			case idLanguage:
				t.Language = strings.TrimRight(string(b), "\x00")
			case idLangIETF:
				t.Language = strings.TrimRight(string(b), "\x00")
			case idName:
				t.Name = strings.TrimRight(string(b), "\x00")
			case idFlagDefault:
				t.Default = uintOf(b) == 1
			case idFlagForced:
				t.Forced = uintOf(b) == 1
			case idFlagHI:
				t.HI = uintOf(b) == 1
			case idEncodings:
				children(b, 0, func(enc element, eb []byte) bool {
					if enc.id != idEncoding {
						return true
					}
					children(eb, 0, func(x element, xb []byte) bool {
						if x.id == idCompression {
							t.CompAlgo = 0
							children(xb, 0, func(y element, yb []byte) bool {
								switch y.id {
								case idCompAlgo:
									t.CompAlgo = int(uintOf(yb))
								case idCompSetting:
									t.CompHead = append([]byte(nil), yb...)
								}
								return true
							})
						}
						return true
					})
					return true
				})
			}
			return true
		})
		if typ == trackTypeSubtitle {
			out = append(out, t)
		}
		return true
	})
	return out
}

func parseCues(body []byte, idx *MKVIndex) {
	byNum := map[uint64]*SubTrack{}
	for _, t := range idx.Tracks {
		byNum[t.Number] = t
	}
	scale := float64(idx.TimeScale) / 1e6
	children(body, 0, func(e element, point []byte) bool {
		if e.id != idCuePoint {
			return true
		}
		var tm uint64
		type tp struct {
			track            uint64
			cluster, rel, du int64
		}
		var tps []tp
		children(point, 0, func(c element, b []byte) bool {
			switch c.id {
			case idCueTime:
				tm = uintOf(b)
			case idCueTrackPos:
				x := tp{cluster: -1, rel: -1, du: -1}
				children(b, 0, func(d element, db []byte) bool {
					switch d.id {
					case idCueTrack:
						x.track = uintOf(db)
					case idCueCluster:
						x.cluster = int64(uintOf(db))
					case idCueRelPos:
						x.rel = int64(uintOf(db))
					case idCueDuration:
						x.du = int64(uintOf(db))
					}
					return true
				})
				tps = append(tps, x)
			}
			return true
		})
		for _, x := range tps {
			t := byNum[x.track]
			if t == nil {
				continue
			}
			c := IndexCue{Ms: int64(float64(tm) * scale), DurMs: -1, ClusterPos: x.cluster, RelPos: x.rel}
			if x.du >= 0 {
				c.DurMs = int64(float64(x.du) * scale)
				t.WithDuration++
			}
			t.Cues = append(t.Cues, c)
		}
		return true
	})
	for _, t := range idx.Tracks {
		sort.Slice(t.Cues, func(i, j int) bool { return t.Cues[i].Ms < t.Cues[j].Ms })
		t.CueCount = len(t.Cues)
	}
}

// ReadCueText reads one indexed packet of a text track and returns its
// words and its block duration (-1 when the block has none). Used for
// ground truth only: the spike's aligner never sees text.
func ReadCueText(ctx context.Context, r *Ranged, idx *MKVIndex, t *SubTrack, c IndexCue) (string, int64, error) {
	if c.ClusterPos < 0 || c.RelPos < 0 {
		return "", -1, errors.New("no relative position")
	}
	abs := idx.SegData + c.ClusterPos
	hdr, err := r.Read(ctx, abs, 16)
	if err != nil {
		return "", -1, err
	}
	cl, err := readElement(hdr, abs)
	if err != nil || cl.id != idCluster {
		return "", -1, errors.New("no cluster at cue position")
	}
	at := cl.dataOff + c.RelPos
	data, err := r.Read(ctx, at, 16<<10)
	if err != nil {
		return "", -1, err
	}
	e, err := readElement(data, at)
	if err != nil {
		return "", -1, err
	}
	body := data[e.hdrLen:]
	if e.size != unknownLen && int(e.size) <= len(body) {
		body = body[:e.size]
	}
	dur := int64(-1)
	var block []byte
	switch e.id {
	case idSimpleBlock:
		block = body
	case idBlockGroup:
		children(body, 0, func(x element, b []byte) bool {
			switch x.id {
			case idBlock:
				block = b
			case idBlockDur:
				dur = int64(float64(uintOf(b)) * float64(idx.TimeScale) / 1e6)
			}
			return true
		})
	default:
		return "", -1, fmt.Errorf("element %x at cue position", e.id)
	}
	if len(block) < 4 {
		return "", -1, errors.New("short block")
	}
	_, n, err := readVint(block, false)
	if err != nil || len(block) < n+3 {
		return "", -1, errors.New("bad block")
	}
	payload := block[n+3:]
	switch t.CompAlgo {
	case 0:
		zr, err := zlib.NewReader(bytes.NewReader(payload))
		if err != nil {
			return "", -1, err
		}
		payload, err = io.ReadAll(io.LimitReader(zr, 1<<20))
		if err != nil {
			return "", -1, err
		}
	case 3:
		payload = append(append([]byte(nil), t.CompHead...), payload...)
	}
	text := string(payload)
	if strings.Contains(t.Codec, "ASS") || strings.Contains(t.Codec, "SSA") {
		// ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
		parts := strings.SplitN(text, ",", 9)
		if len(parts) == 9 {
			text = parts[8]
		}
	}
	return text, dur, nil
}
