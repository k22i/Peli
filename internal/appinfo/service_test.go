package appinfo

import "testing"

func TestVersion(t *testing.T) {
	old := Version
	t.Cleanup(func() { Version = old })

	Version = "1.2.3"
	if got := (Service{}).Version(); got != "1.2.3" {
		t.Fatalf("Version() = %q, want %q", got, "1.2.3")
	}
}
