//go:build !darwin || ios

package pairing

import (
	"context"
	"errors"
)

// Only a Mac types a phrase (ADR-0061: a phone or tablet scans), so only
// macOS advertises and browses. Windows and Linux would need their own
// DNS-SD; until then the phrase path isn't offered there.

// PhraseAvailable reports whether this build can pair by phrase.
const PhraseAvailable = false

func advertise(int, uint16) (func(), error) {
	return nil, errors.New("pairing: no Bonjour here")
}

func find(context.Context, int) (string, uint16, error) { return "", 0, ErrNoSender }
