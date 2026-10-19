package licences

import (
	"strings"
	"testing"
)

func TestNotices(t *testing.T) {
	n, err := Service{}.Notices()
	if err != nil {
		t.Fatal(err)
	}
	if n.App.Licence != "MIT" || !strings.Contains(n.App.Text, "Permission is hereby granted") {
		t.Errorf("app licence = %q, want the MIT text", n.App.Licence)
	}

	have := map[string]Component{}
	for _, c := range n.Components {
		have[c.Name] = c
		if c.Licence == "" || c.Text == "" {
			t.Errorf("%s has no licence or text", c.Name)
		}
	}
	// Stack members that must be credited, and libmpv's LGPL.
	for _, name := range []string{"libmpv and FFmpeg", "github.com/wailsapp/wails/v3", "go.etcd.io/bbolt", "react"} {
		if _, ok := have[name]; !ok {
			t.Errorf("no notice for %s", name)
		}
	}
	if got := have["libmpv and FFmpeg"].Licence; got != "LGPL-2.1-or-later" {
		t.Errorf("libmpv licence = %q", got)
	}
}
