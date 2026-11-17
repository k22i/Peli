package pairing

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net/netip"
	"strings"
	"time"
)

// CodePrefix starts every pairing QR code; the scanner ignores other codes.
const CodePrefix = "peli-pair:v1:"

// Mode is which way the grants go, from the side showing the code.
type Mode byte

const (
	// ModeOffer: the device showing the code has the grants; the scanner
	// receives them (Mac → iPhone).
	ModeOffer Mode = 1
	// ModeRequest: the device showing the code wants them; the scanner
	// sends them (iPhone → Mac: the camera always scans, ADR-0061).
	ModeRequest Mode = 2
)

// maxAddrs is how many addresses a code carries.
const maxAddrs = 4

// ErrBadCode means the scanned text isn't a pairing code this build reads.
var ErrBadCode = errors.New("pairing: not a Peli pairing code")

// Code is what the QR code carries. Key and the sender's X25519 public key
// are the secrets: the code is only on screen while the dialog is open.
type Code struct {
	Mode    Mode
	Expires time.Time
	Session [16]byte
	Account [16]byte
	Key     [32]byte
	Pub     [32]byte
	Port    uint16
	Addrs   []netip.Addr
}

// String is the code as the QR code's text: CodePrefix and base64url of
// version, mode, expiry (Unix seconds), session, account hash, key, public
// key, port, then a count and each address (4 or 16 bytes, length first).
func (c Code) String() string {
	b := make([]byte, 0, 2+8+16+16+32+32+2+1+maxAddrs*17)
	b = append(b, 1, byte(c.Mode))
	b = binary.BigEndian.AppendUint64(b, uint64(c.Expires.Unix()))
	b = append(b, c.Session[:]...)
	b = append(b, c.Account[:]...)
	b = append(b, c.Key[:]...)
	b = append(b, c.Pub[:]...)
	b = binary.BigEndian.AppendUint16(b, c.Port)
	addrs := c.Addrs[:min(len(c.Addrs), maxAddrs)]
	b = append(b, byte(len(addrs)))
	for _, a := range addrs {
		raw := a.Unmap().AsSlice()
		b = append(b, byte(len(raw)))
		b = append(b, raw...)
	}
	return CodePrefix + base64.RawURLEncoding.EncodeToString(b)
}

// ParseCode reads a scanned code.
func ParseCode(s string) (Code, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(s), CodePrefix)
	if !ok {
		return Code{}, ErrBadCode
	}
	b, err := base64.RawURLEncoding.DecodeString(rest)
	if err != nil || len(b) < 2+8+16+16+32+32+2+1 || b[0] != 1 {
		return Code{}, ErrBadCode
	}
	var c Code
	c.Mode = Mode(b[1])
	if c.Mode != ModeOffer && c.Mode != ModeRequest {
		return Code{}, ErrBadCode
	}
	c.Expires = time.Unix(int64(binary.BigEndian.Uint64(b[2:10])), 0)
	b = b[10:]
	b = b[copy(c.Session[:], b):]
	b = b[copy(c.Account[:], b):]
	b = b[copy(c.Key[:], b):]
	b = b[copy(c.Pub[:], b):]
	c.Port = binary.BigEndian.Uint16(b)
	n := int(b[2])
	b = b[3:]
	if n > maxAddrs {
		return Code{}, ErrBadCode
	}
	for range n {
		if len(b) < 1 || (b[0] != 4 && b[0] != 16) || len(b) < 1+int(b[0]) {
			return Code{}, ErrBadCode
		}
		a, _ := netip.AddrFromSlice(b[1 : 1+b[0]])
		c.Addrs = append(c.Addrs, a)
		b = b[1+b[0]:]
	}
	if len(b) != 0 || c.Port == 0 || len(c.Addrs) == 0 {
		return Code{}, ErrBadCode
	}
	return c, nil
}
