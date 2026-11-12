//go:build !darwin

package updates

import "fmt"

// installed: macOS first (#83). Windows gets its install strategy with its
// installer (#77); Linux is deferred until after v1.0 (#103).
type installed struct{}

func (installed) Where() (string, Reason) { return "", Unsupported }

func (installed) Check(string, string, string) error {
	return fmt.Errorf("%w: no install strategy on this OS", ErrMismatch)
}
