package store

import "testing"

var kitsu = Addon{URL: "https://anime-kitsu.strem.fun/manifest.json", Name: "Kitsu", Enabled: true}

// Each profile is offered the built-in addons once, before Kitsu's, and
// one the user removes stays removed (#107).
func TestOfferBuiltins(t *testing.T) {
	s, _ := openTemp(t)
	before := must[Profile](t)(s.CreateProfile(Profile{Name: "Before", NuvioIndex: ptr(1)}))
	check(t, s.InstallAddon(before.ID, cinemeta))
	check(t, s.InstallAddon(before.ID, kitsu))
	check(t, s.UseBuiltins(Builtins))
	equal(t, must[[]Addon](t)(s.Addons(before.ID)), []Addon{cinemeta, AniListAddon, kitsu})

	after := must[Profile](t)(s.CreateProfile(Profile{Name: "After", NuvioIndex: ptr(2)}))
	equal(t, must[[]Addon](t)(s.Addons(after.ID)), []Addon{AniListAddon})

	check(t, s.RemoveAddon(before.ID, AniListAddon.URL))
	check(t, s.UseBuiltins(Builtins))
	equal(t, must[[]Addon](t)(s.Addons(before.ID)), []Addon{cinemeta, kitsu})
}

// Pulled lists never carry built-in addons; the device's stay where they
// were.
func TestKeepBuiltins(t *testing.T) {
	b := AniListAddon
	for _, c := range []struct {
		name               string
		have, pulled, want []Addon
	}{
		{"after the addon it followed", []Addon{cinemeta, b, kitsu}, []Addon{kitsu, cinemeta}, []Addon{kitsu, cinemeta, b}},
		{"first stays first", []Addon{b, cinemeta}, []Addon{subtitles, cinemeta}, []Addon{b, subtitles, cinemeta}},
		{"alone: before Kitsu", []Addon{b}, []Addon{cinemeta, kitsu}, []Addon{cinemeta, b, kitsu}},
		{"alone: last", []Addon{b}, []Addon{cinemeta}, []Addon{cinemeta, b}},
		{"a pulled copy is dropped", []Addon{cinemeta, b}, []Addon{b, cinemeta}, []Addon{cinemeta, b}},
		{"none", []Addon{cinemeta}, []Addon{kitsu}, []Addon{kitsu}},
	} {
		t.Run(c.name, func(t *testing.T) { equal(t, keepBuiltins(c.have, c.pulled), c.want) })
	}
}

// Editing only a built-in addon queues no push.
func TestBuiltinEditsQueueNothing(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	check(t, s.UseBuiltins(Builtins))
	check(t, s.EnableAddon(linked.ID, AniListAddon.URL, false))
	check(t, s.MoveAddon(linked.ID, AniListAddon.URL, 0))
	equal(t, must[[]Push](t)(s.Pending(linked.ID)), []Push{})
}
