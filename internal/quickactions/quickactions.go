// Package quickactions is the Home Screen icon menu (#141): the items a long
// press on Peli's icon shows, and the tap that comes back.
//
// Search and Library are static items in Info.plist. Continue watching is
// dynamic: the frontend, which knows the titles' names, sends the latest two
// with SetItems. A tap (on a running app, or the one that launched it) lands
// in Pending; the frontend takes it with TakePending when it is ready for it
// (a profile chosen, any PIN entered), which is why an event only says that
// one is waiting.
//
// The Service is bound on every platform, because the frontend's bindings
// come from the desktop build (ADR-0055); off iOS it does nothing.
package quickactions

import (
	"context"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// EventPending says a tap is waiting for TakePending.
const EventPending = "quickactions:pending"

// The kinds of Action.
const (
	KindSearch  = "search"
	KindLibrary = "library"
	KindTitle   = "title"
)

// MaxItems is how many titles the menu offers. iOS shows four items in all,
// and two are the static ones.
const MaxItems = 2

// Item is one Continue Watching entry in the menu.
type Item struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	VideoID string `json:"videoId,omitempty"`
	// Title is the menu's heading, Subtitle the line under it:
	// "S1 · E2 · 34 min left".
	Title    string `json:"title"`
	Subtitle string `json:"subtitle,omitempty"`
}

// Action is a tap on an item. Kind says which; the rest is set for a title.
type Action struct {
	Kind    string `json:"kind"`
	Type    string `json:"type,omitempty"`
	ID      string `json:"id,omitempty"`
	VideoID string `json:"videoId,omitempty"`
	Title   string `json:"title,omitempty"`
	// Play goes straight into the play flow (the picker, or the remembered
	// source) rather than opening the title's page.
	Play bool `json:"play,omitempty"`
}

func init() {
	application.RegisterEvent[application.Void](EventPending)
}

// Service is the bound API. The zero value is ready.
type Service struct{}

var (
	mu      sync.Mutex
	emit    func()
	pending *Action
)

// ServiceStartup wires the pending event to the app.
func (*Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		mu.Lock()
		emit = func() { app.Event.Emit(EventPending) }
		mu.Unlock()
	}
	return nil
}

// fire records a tap. A later tap replaces one nobody took.
func fire(a Action) {
	mu.Lock()
	pending = &a
	e := emit
	mu.Unlock()
	if e != nil {
		e()
	}
}

// SetItems replaces the menu's Continue watching items with the first two
// valid ones in items. An empty list clears them: the frontend sends that for
// a PIN-locked profile, whose titles must not show on the Home Screen.
func (*Service) SetItems(items []Item) error { return setItems(Clean(items)) }

// TakePending returns the tap waiting to be handled, once, or nil.
func (*Service) TakePending() *Action {
	mu.Lock()
	defer mu.Unlock()
	a := pending
	pending = nil
	return a
}

// Clean keeps the items that can be opened (a type, an id and a name) and no
// more than MaxItems of them.
func Clean(items []Item) []Item {
	out := make([]Item, 0, MaxItems)
	for _, item := range items {
		item.Title = strings.TrimSpace(item.Title)
		if item.Type == "" || item.ID == "" || item.Title == "" {
			continue
		}
		out = append(out, item)
		if len(out) == MaxItems {
			break
		}
	}
	return out
}
