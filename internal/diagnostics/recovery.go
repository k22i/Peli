package diagnostics

import (
	"net/url"
	"strings"
	"sync"
	"time"
)

// Action is what the webview does after iOS killed its content process.
type Action int

const (
	// Reload loads Peli again on the route it was on.
	Reload Action = iota
	// ReloadHome loads Home, with a toast saying why: the page died twice in
	// a short time, so the route itself may be what runs out of memory.
	ReloadHome
	// ErrorPage shows a plain page with a Reload button and no Peli on it:
	// three deaths in two minutes, and reloading by itself would loop.
	ErrorPage
)

const (
	homeWithin  = 30 * time.Second
	errorWithin = 2 * time.Minute
)

// RecoveredParam is the query parameter the reloaded page finds
// (lib/recovery.ts): "reload" or "home".
const RecoveredParam = "peli-recovered"

// recovery is the loop guard: when the content process died.
type recovery struct {
	mu     sync.Mutex
	deaths []time.Time
	total  int
}

// died records a death at now and says what to do about it, with the
// number of deaths since launch.
func (r *recovery) died(now time.Time) (Action, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.total++
	kept := r.deaths[:0]
	for _, t := range r.deaths {
		if now.Sub(t) < errorWithin {
			kept = append(kept, t)
		}
	}
	r.deaths = append(kept, now)
	recent := 0
	for _, t := range r.deaths {
		if now.Sub(t) < homeWithin {
			recent++
		}
	}
	switch {
	case len(r.deaths) >= 3:
		return ErrorPage, r.total
	case recent >= 2:
		return ReloadHome, r.total
	}
	return Reload, r.total
}

// recoveryURL is the address to load for action, from the address the
// webview had (current, which may be empty) and the route the frontend last
// saved (route, a hash route such as "/title/movie/tt1?x=1", or empty).
//
// The router uses hash history, so the route is the fragment. The saved
// route wins over the one in current: for the player it is already the
// title the player was opened from (lib/recovery.ts).
func recoveryURL(current, route string, action Action) string {
	u, err := url.Parse(current)
	if err != nil || u.Scheme == "" || u.Host == "" {
		u = &url.URL{Scheme: "wails", Host: "localhost"}
	}
	target := url.URL{Scheme: u.Scheme, Host: u.Host, Path: "/"}
	switch action {
	case ReloadHome:
		target.RawQuery = RecoveredParam + "=home"
		target.Fragment = "/"
	default:
		target.RawQuery = RecoveredParam + "=reload"
		switch {
		case route != "":
			target.Fragment = route
		case u.Fragment != "":
			target.Fragment = u.Fragment
		default:
			target.Fragment = "/"
		}
		if !strings.HasPrefix(target.Fragment, "/") {
			target.Fragment = "/" + target.Fragment
		}
	}
	return target.String()
}
