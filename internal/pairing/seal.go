package pairing

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

// The construction (ADR-0061, approved 2026-11-17). The scanner proves it
// holds K with an HMAC over the session and its ephemeral public key R; both
// sides then seal with a key from K and the X25519 secret of R and the
// shower's key S, so a recording opened later with a photographed QR stays
// shut. The additional data binds the direction, mode, session, account and
// both public keys.

// ErrOpen means a sealed message didn't open: tampered, or the wrong key.
var ErrOpen = errors.New("pairing: the message didn't open")

// Directions, in the additional data, so an answer can't pass for a request.
const (
	dirRequest = 'q'
	dirAnswer  = 'a'
)

// keyPair is an ephemeral X25519 key pair.
type keyPair struct {
	private, public [32]byte
}

func newKeyPair() (keyPair, error) {
	var k keyPair
	if _, err := io.ReadFull(rand.Reader, k.private[:]); err != nil {
		return k, err
	}
	pub, err := curve25519.X25519(k.private[:], curve25519.Basepoint)
	if err != nil {
		return k, err
	}
	copy(k.public[:], pub)
	return k, nil
}

func derive(secret, salt []byte, info string) []byte {
	out := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, secret, salt, []byte(info)), out); err != nil {
		panic(err) // 32 bytes from HKDF-SHA256 can't fail
	}
	return out
}

// proof is what a scanner sends to show it holds k.
func proof(k []byte, session [16]byte, r [32]byte) []byte {
	mac := hmac.New(sha256.New, derive(k, nil, "peli-pair v1 proof"))
	mac.Write(session[:])
	mac.Write(r[:])
	return mac.Sum(nil)
}

func proofOK(k []byte, session [16]byte, r [32]byte, got []byte) bool {
	return hmac.Equal(proof(k, session, r), got)
}

// transcript is what both sides agree on for one transfer.
type transcript struct {
	mode    Mode
	session [16]byte
	account [16]byte
	s, r    [32]byte
}

func (t transcript) aad(dir byte) []byte {
	b := []byte("peli-pair v1")
	b = append(b, dir, byte(t.mode))
	b = append(b, t.session[:]...)
	b = append(b, t.account[:]...)
	b = append(b, t.s[:]...)
	return append(b, t.r[:]...)
}

// sealKey is the transfer's key: HKDF over K and the X25519 secret.
func sealKey(k []byte, mine [32]byte, theirs [32]byte, session [16]byte) ([]byte, error) {
	ss, err := curve25519.X25519(mine[:], theirs[:])
	if err != nil {
		return nil, err
	}
	return derive(append(append([]byte{}, k...), ss...), session[:], "peli-pair v1 seal"), nil
}

// seal is nonce ‖ XChaCha20-Poly1305(key, nonce, plain, aad).
func seal(key, aad, plain []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize(), aead.NonceSize()+len(plain)+aead.Overhead())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, plain, aad), nil
}

func open(key, aad, msg []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	if len(msg) < aead.NonceSize()+aead.Overhead() {
		return nil, ErrOpen
	}
	plain, err := aead.Open(nil, msg[:aead.NonceSize()], msg[aead.NonceSize():], aad)
	if err != nil {
		return nil, ErrOpen
	}
	return plain, nil
}
