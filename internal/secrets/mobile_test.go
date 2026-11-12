package secrets

import (
	"errors"
	"testing"
)

// fakeKeyValues is a map behind the mobile shell's store.
func fakeKeyValues() (keyValues, map[string]string) {
	items := map[string]string{}
	return keyValues{
		set:    func(k, v string) error { items[k] = v; return nil },
		get:    func(k string) (string, bool, error) { v, ok := items[k]; return v, ok, nil },
		delete: func(k string) error { delete(items, k); return nil },
	}, items
}

func TestMobileBackend(t *testing.T) {
	kv, items := fakeKeyValues()
	k := &Keychain{service: "Peli", os: mobile{kv}}

	if _, err := k.Get("nuvio.session"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get before Set = %v, want ErrNotFound", err)
	}
	if err := k.Set("nuvio.session", "secret"); err != nil {
		t.Fatal(err)
	}
	if got, ok := items["Peli/nuvio.session"]; !ok || got != "secret" {
		t.Errorf("items = %v, want Peli/nuvio.session filed under the service", items)
	}
	if got, err := k.Get("nuvio.session"); err != nil || got != "secret" {
		t.Errorf("Get = %q, %v", got, err)
	}
	if err := k.Delete("nuvio.session"); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("nuvio.session"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get after Delete = %v, want ErrNotFound", err)
	}
	// Deleting what isn't there is fine.
	if err := k.Delete("nuvio.session"); err != nil {
		t.Errorf("Delete twice = %v", err)
	}
}
