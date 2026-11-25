package livetv

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

// How long a refresh may run on after ServiceShutdown gives up waiting.
const shutdownWait = 5 * time.Second

// A guide request's and a source name's limits.
const (
	maxGuideChannels = 1000
	maxNameRunes     = 80
)

// Service is the Wails service for Live TV (ADR-0066).
// Every method but Sources refuses a kids profile with CodeKids; Sources
// answers an empty list for one.
type Service struct {
	cfg Config

	now   func() time.Time
	httpc *http.Client
	emit  func(name string, data any)

	// How long a parsed playlist and guide stay good, how long a failing
	// source is left alone, and how often the timer looks for stale ones.
	playlistTTL time.Duration
	guideTTL    time.Duration
	retryAfter  time.Duration
	tickEvery   time.Duration

	// ctx is what the fetches run under; ServiceShutdown cancels it.
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	closed   bool
	tickStop chan struct{}

	// mu guards sources, refreshing and everything inside a loaded. Writes to
	// the disk happen outside it, from a copy.
	mu         sync.Mutex
	sources    map[string]*loaded
	refreshing map[string]bool
}

// NewService returns a Service. It does nothing until it starts.
func NewService(cfg Config) *Service {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{
		cfg:   cfg,
		now:   time.Now,
		httpc: &http.Client{Transport: transport},
		emit:  func(string, any) {},

		playlistTTL: 12 * time.Hour,
		guideTTL:    6 * time.Hour,
		retryAfter:  10 * time.Minute,
		tickEvery:   30 * time.Minute,

		ctx:        ctx,
		cancel:     cancel,
		sources:    map[string]*loaded{},
		refreshing: map[string]bool{},
	}
}

// ServiceStartup sends events from now on and starts the refresh timer.
func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.emit = func(name string, data any) { app.Event.Emit(name, data) }
	}
	s.mu.Lock()
	stop := make(chan struct{})
	s.tickStop = stop
	s.mu.Unlock()

	s.wg.Add(1)
	safego.Go("livetv-timer", func() {
		defer s.wg.Done()
		ticker := time.NewTicker(s.tickEvery)
		defer ticker.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-stop:
				return
			case <-ticker.C:
				s.tick()
			}
		}
	})
	s.wg.Add(1)
	safego.Go("livetv-sweep", func() {
		defer s.wg.Done()
		s.sweep()
	})
	return nil
}

// ServiceShutdown stops the timer and any running fetch.
func (s *Service) ServiceShutdown() error {
	s.mu.Lock()
	s.closed = true
	stop := s.tickStop
	s.tickStop = nil
	s.mu.Unlock()
	if stop != nil {
		close(stop)
	}
	s.cancel()
	done := make(chan struct{})
	safego.Go("livetv-shutdown", func() {
		defer close(done)
		s.wg.Wait()
	})
	select {
	case <-done:
	case <-time.After(shutdownWait):
		slog.Warn("livetv: shutdown", "code", CodeTimeout)
	}
	return nil
}

// Sources lists profileID's sources, oldest first. A stale one starts a
// background refresh and is returned as it was.
func (s *Service) Sources(profileID uint64) ([]Source, error) {
	db, err := s.store()
	if err != nil {
		return nil, err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		// A kids profile is shown nothing rather than refused, so the page
		// and the nav entry can ask without handling an error.
		if codeOf(err) == CodeKids {
			return []Source{}, nil
		}
		return nil, err
	}
	records, err := db.LiveSources(profileID)
	if err != nil {
		return nil, err
	}
	out := make([]Source, 0, len(records))
	for _, rec := range records {
		if s.due(rec.ID) {
			s.startRefresh(rec.ID, false)
		}
		out = append(out, s.view(rec))
	}
	return out, nil
}

// AddSource checks the input, keeps the URLs in the keychain, saves the
// record and starts its first refresh in the background.
func (s *Service) AddSource(in SourceInput) (Source, error) {
	db, err := s.store()
	if err != nil {
		return Source{}, err
	}
	if _, err := s.guardKids(db, in.ProfileID); err != nil {
		return Source{}, err
	}
	playlist, err := checkURL(in.PlaylistURL)
	if err != nil {
		return Source{}, err
	}
	guide := ""
	if strings.TrimSpace(in.GuideURL) != "" {
		if guide, err = checkURL(in.GuideURL); err != nil {
			return Source{}, err
		}
	}
	keychain, err := s.keychain()
	if err != nil {
		return Source{}, err
	}
	id, err := newID()
	if err != nil {
		return Source{}, fail(CodeFailed)
	}
	name := cleanName(in.Name)
	if name == "" {
		name = defaultName(playlist)
	}
	if err := keychain.Set(playlistKey(id), playlist); err != nil {
		return Source{}, fail(CodeKeychain)
	}
	if guide != "" {
		if err := keychain.Set(guideKey(id), guide); err != nil {
			// Don't leave half a source's URLs behind.
			s.deleteKeys(id)
			return Source{}, fail(CodeKeychain)
		}
	}
	now := s.now().UnixMilli()
	rec := store.LiveSource{
		ID:        id,
		ProfileID: in.ProfileID,
		Name:      name,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := db.PutLiveSource(rec); err != nil {
		// The URLs would outlive the record that explains them.
		s.deleteKeys(id)
		return Source{}, err
	}
	s.emit(EventUpdated, Updated{ProfileID: rec.ProfileID, SourceID: id})
	s.startRefresh(id, true)
	src := s.view(rec)
	src.Refreshing = true
	return src, nil
}

// RemoveSource deletes a source: its record, its keychain items and its
// cache, and its channels from the profile's favourites and recents.
func (s *Service) RemoveSource(profileID uint64, sourceID string) error {
	db, err := s.store()
	if err != nil {
		return err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return err
	}
	rec, err := s.owned(db, profileID, sourceID)
	if err != nil {
		return err
	}
	if err := s.forget(db, rec); err != nil {
		return err
	}
	s.emit(EventUpdated, Updated{ProfileID: profileID, SourceID: sourceID})
	return nil
}

// RenameSource sets a source's name.
func (s *Service) RenameSource(profileID uint64, sourceID, name string) error {
	db, err := s.store()
	if err != nil {
		return err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return err
	}
	rec, err := s.owned(db, profileID, sourceID)
	if err != nil {
		return err
	}
	name = cleanName(name)
	if name == "" {
		return fail(CodeInvalid)
	}
	rec.Name = name
	rec.UpdatedAt = s.now().UnixMilli()
	if err := db.PutLiveSource(rec); err != nil {
		return err
	}
	s.emit(EventUpdated, Updated{ProfileID: profileID, SourceID: sourceID})
	return nil
}

// Refresh fetches a source's playlist and guide again in the background, or
// every source of the profile's for sourceID "". It returns at once.
func (s *Service) Refresh(profileID uint64, sourceID string) error {
	db, err := s.store()
	if err != nil {
		return err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return err
	}
	ids, err := s.sourceIDs(db, profileID, sourceID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		s.startRefresh(id, true)
	}
	return nil
}

// Channels lists a source's channels in playlist order, or every source's
// (in source order) for sourceID "". A channel carries no stream: Stream
// hands that over, at play time.
func (s *Service) Channels(profileID uint64, sourceID string) ([]Channel, error) {
	db, err := s.store()
	if err != nil {
		return nil, err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return nil, err
	}
	ids, err := s.sourceIDs(db, profileID, sourceID)
	if err != nil {
		return nil, err
	}
	out := []Channel{}
	for _, id := range ids {
		out = append(out, s.sourceChannels(id)...)
	}
	return out, nil
}

// Guide returns each channel's programmes that overlap [from, to) (unix ms),
// in the order of channelIDs. A channel with none has an empty list.
func (s *Service) Guide(profileID uint64, channelIDs []string, from, to int64) ([]ChannelGuide, error) {
	db, err := s.store()
	if err != nil {
		return nil, err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return nil, err
	}
	if len(channelIDs) > maxGuideChannels {
		return nil, fail(CodeInvalid)
	}
	if to <= from {
		return nil, fail(CodeInvalid)
	}
	allowed, err := s.profileSources(db, profileID)
	if err != nil {
		return nil, err
	}
	out := make([]ChannelGuide, 0, len(channelIDs))
	for _, channelID := range channelIDs {
		guide := ChannelGuide{ChannelID: channelID, Programmes: []Programme{}}
		if source := sourceOfChannel(channelID); allowed[source] {
			for _, programme := range s.programmes(source, channelID) {
				if programme.Stop > from && programme.Start < to {
					guide.Programmes = append(guide.Programmes, programme)
				}
			}
		}
		out = append(out, guide)
	}
	return out, nil
}

// NowNext returns what each channel shows now and next, in the order of
// channelIDs.
func (s *Service) NowNext(profileID uint64, channelIDs []string) ([]NowNext, error) {
	db, err := s.store()
	if err != nil {
		return nil, err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return nil, err
	}
	allowed, err := s.profileSources(db, profileID)
	if err != nil {
		return nil, err
	}
	t := s.now().UnixMilli()
	out := make([]NowNext, 0, len(channelIDs))
	for _, channelID := range channelIDs {
		nowNext := NowNext{ChannelID: channelID}
		if source := sourceOfChannel(channelID); allowed[source] {
			programmes := s.programmes(source, channelID)
			from := t
			for _, programme := range programmes {
				if programme.Start <= t && t < programme.Stop {
					nowNext.Now = copyProgramme(programme)
					from = programme.Stop
					break
				}
			}
			for _, programme := range programmes {
				if programme.Start >= from {
					nowNext.Next = copyProgramme(programme)
					break
				}
			}
		}
		out = append(out, nowNext)
	}
	return out, nil
}

// Stream returns the channel's stream for Player.Load (Origin
// "livetv:<channel id>") and puts the channel first in the profile's recent
// channels.
func (s *Service) Stream(profileID uint64, channelID string) (streams.Source, error) {
	db, err := s.store()
	if err != nil {
		return streams.Source{}, err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return streams.Source{}, err
	}
	source := sourceOfChannel(channelID)
	if _, err := s.owned(db, profileID, source); err != nil {
		return streams.Source{}, err
	}
	entry, ok := s.entryOf(source, channelID)
	if !ok {
		return streams.Source{}, fail(CodeNotFound)
	}
	s.remember(db, profileID, channelID)
	return streams.Source{
		URL:       entry.URL,
		Origin:    "livetv:" + channelID,
		Headers:   copyHeaders(entry.Headers),
		UserAgent: entry.UserAgent,
	}, nil
}

// Favourites returns the profile's favourite channel ids, oldest first.
func (s *Service) Favourites(profileID uint64) ([]string, error) {
	db, err := s.store()
	if err != nil {
		return nil, err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return nil, err
	}
	list, err := db.LiveFavourites(profileID)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []string{}
	}
	return list, nil
}

// SetFavourite adds a channel to the profile's favourites (at the end) or
// takes it out, and returns the new list.
func (s *Service) SetFavourite(profileID uint64, channelID string, on bool) ([]string, error) {
	db, err := s.store()
	if err != nil {
		return nil, err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return nil, err
	}
	source := sourceOfChannel(channelID)
	if _, err := s.owned(db, profileID, source); err != nil {
		return nil, err
	}
	if !s.hasChannel(source, channelID) {
		return nil, fail(CodeNotFound)
	}
	list, err := db.LiveFavourites(profileID)
	if err != nil {
		return nil, err
	}
	switch {
	case on && !slices.Contains(list, channelID):
		list = append(list, channelID)
	case !on:
		list = slices.DeleteFunc(list, func(id string) bool { return id == channelID })
	}
	if list == nil {
		list = []string{}
	}
	if len(list) > store.MaxLiveFavourites {
		return nil, fail(CodeInvalid)
	}
	if err := db.SetLiveFavourites(profileID, list); err != nil {
		return nil, err
	}
	return list, nil
}

// Recent returns the channels the profile played last, newest first.
func (s *Service) Recent(profileID uint64) ([]string, error) {
	db, err := s.store()
	if err != nil {
		return nil, err
	}
	if _, err := s.guardKids(db, profileID); err != nil {
		return nil, err
	}
	list, err := db.LiveRecent(profileID)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []string{}
	}
	return list, nil
}

// store is the app's store, or CodeFailed when there is none.
func (s *Service) store() (*store.Store, error) {
	if s.cfg.Open == nil {
		return nil, fail(CodeFailed)
	}
	db := s.cfg.Open()
	if db == nil {
		return nil, fail(CodeFailed)
	}
	return db, nil
}

// keychain is where the URLs are kept, or CodeKeychain when there is none.
func (s *Service) keychain() (Keychain, error) {
	if s.cfg.Keychain == nil {
		return nil, fail(CodeKeychain)
	}
	return s.cfg.Keychain, nil
}

// stored reads one of a source's URLs from the keychain.
func (s *Service) stored(key string) (string, error) {
	k, err := s.keychain()
	if err != nil {
		return "", err
	}
	return k.Get(key)
}

// deleteKeys takes a source's URLs back out of the keychain. It is used on a
// half-made source, so a failure has nowhere to go.
func (s *Service) deleteKeys(id string) {
	if k := s.cfg.Keychain; k != nil {
		_ = k.Delete(playlistKey(id))
		_ = k.Delete(guideKey(id))
	}
}

// guardKids returns profileID's profile, refusing a kids one: Live TV is not
// for them (ADR-0066).
func (s *Service) guardKids(db *store.Store, profileID uint64) (store.Profile, error) {
	profile, err := db.Profile(profileID)
	if err != nil {
		return store.Profile{}, err
	}
	if profile.Kids {
		return profile, fail(CodeKids)
	}
	return profile, nil
}

// owned returns a source's record, refusing one that belongs to another
// profile or isn't there: an id is private to the profile that made it.
func (s *Service) owned(db *store.Store, profileID uint64, sourceID string) (store.LiveSource, error) {
	if !validID(sourceID) {
		return store.LiveSource{}, fail(CodeNotFound)
	}
	rec, err := db.LiveSource(sourceID)
	if err != nil {
		return store.LiveSource{}, err
	}
	if rec.ProfileID != profileID {
		return store.LiveSource{}, fail(CodeNotFound)
	}
	return rec, nil
}

// sourceIDs is sourceID checked against the profile, or every source of the
// profile's in order when sourceID is "".
func (s *Service) sourceIDs(db *store.Store, profileID uint64, sourceID string) ([]string, error) {
	if sourceID != "" {
		rec, err := s.owned(db, profileID, sourceID)
		if err != nil {
			return nil, err
		}
		return []string{rec.ID}, nil
	}
	records, err := db.LiveSources(profileID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(records))
	for _, rec := range records {
		ids = append(ids, rec.ID)
	}
	return ids, nil
}

// profileSources is the profile's source ids as a set, for checking that a
// channel belongs to it.
func (s *Service) profileSources(db *store.Store, profileID uint64) (map[string]bool, error) {
	ids, err := s.sourceIDs(db, profileID, "")
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]bool, len(ids))
	for _, id := range ids {
		allowed[id] = true
	}
	return allowed, nil
}

// forget removes a source everywhere: its keychain items, its cache folder,
// its in-memory state, its record, and its channels from the profile's
// favourites and recent list.
func (s *Service) forget(db *store.Store, rec store.LiveSource) error {
	s.deleteKeys(rec.ID)
	s.forgetCache(rec.ID)
	s.mu.Lock()
	delete(s.sources, rec.ID)
	s.mu.Unlock()
	if err := db.DeleteLiveSource(rec.ID); err != nil {
		return err
	}
	return s.withoutChannels(db, rec.ProfileID, rec.ID+":")
}

// withoutChannels drops the channels whose id starts with prefix from the
// profile's favourites and recent list, so a removed source leaves neither.
func (s *Service) withoutChannels(db *store.Store, profileID uint64, prefix string) error {
	favourites, err := db.LiveFavourites(profileID)
	if errors.Is(err, store.ErrProfileNotFound) {
		return nil // the profile is gone, and its lists with it
	}
	if err != nil {
		return err
	}
	if kept := without(favourites, prefix); len(kept) != len(favourites) {
		if err := db.SetLiveFavourites(profileID, kept); err != nil {
			return err
		}
	}
	recent, err := db.LiveRecent(profileID)
	if err != nil {
		return err
	}
	if kept := without(recent, prefix); len(kept) != len(recent) {
		if err := db.SetLiveRecent(profileID, kept); err != nil {
			return err
		}
	}
	return nil
}

// without is list with the ids that start with prefix taken out.
func without(list []string, prefix string) []string {
	kept := make([]string, 0, len(list))
	for _, id := range list {
		if !strings.HasPrefix(id, prefix) {
			kept = append(kept, id)
		}
	}
	return kept
}

// remember puts channelID first in the profile's recent channels, without
// repeating it and within the store's cap.
func (s *Service) remember(db *store.Store, profileID uint64, channelID string) {
	previous, err := db.LiveRecent(profileID)
	if err != nil {
		slog.Warn("livetv: recent", "code", codeOf(err))
		return
	}
	list := make([]string, 0, len(previous)+1)
	list = append(list, channelID)
	for _, id := range previous {
		if id != channelID && len(list) < store.MaxLiveRecent {
			list = append(list, id)
		}
	}
	if err := db.SetLiveRecent(profileID, list); err != nil {
		slog.Warn("livetv: recent", "code", codeOf(err))
	}
}

// view is a source's record and its last refresh, as the frontend sees it.
func (s *Service) view(rec store.LiveSource) Source {
	s.mu.Lock()
	st := s.ensureLocked(rec.ID).status
	refreshing := s.refreshing[rec.ID]
	s.mu.Unlock()
	return Source{
		ID:                rec.ID,
		ProfileID:         rec.ProfileID,
		Name:              rec.Name,
		CreatedAt:         rec.CreatedAt,
		UpdatedAt:         rec.UpdatedAt,
		HasGuide:          st.HasGuide,
		GuideFromPlaylist: st.GuideFromPlaylist,
		Channels:          st.Channels,
		GuideChannels:     st.GuideChannels,
		Programmes:        st.Programmes,
		PlaylistAt:        st.PlaylistAt,
		GuideAt:           st.GuideAt,
		PlaylistError:     st.PlaylistError,
		GuideError:        st.GuideError,
		Refreshing:        refreshing,
	}
}

// sourceChannels copies a source's channels.
func (s *Service) sourceChannels(id string) []Channel {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.ensureLocked(id)
	return append([]Channel(nil), l.channels...)
}

// hasChannel says whether channelID is one of id's channels.
func (s *Service) hasChannel(id, channelID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.ensureLocked(id).index[channelID]
	return ok
}

// entryOf copies out a channel's playlist entry, which holds its stream.
func (s *Service) entryOf(id, channelID string) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.ensureLocked(id)
	i, ok := l.index[channelID]
	if !ok || i < 0 || i >= len(l.entries) {
		return Entry{}, false
	}
	return l.entries[i], true
}

// programmes copies a channel's guide entries, in order.
func (s *Service) programmes(id, channelID string) []Programme {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.ensureLocked(id).guide[channelID]
	return append([]Programme(nil), list...)
}

// copyProgramme is a programme of its own, so a caller can't reach into the
// cache through it.
func copyProgramme(p Programme) *Programme {
	copied := p
	copied.Categories = append([]string(nil), p.Categories...)
	return &copied
}

// copyHeaders copies an entry's request headers: never nil, so the player has
// a map to fill.
func copyHeaders(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for name, value := range in {
		out[name] = value
	}
	return out
}

// idPattern is what a source id is: 16 lowercase hex characters.
var idPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

func validID(id string) bool { return idPattern.MatchString(id) }

// newID makes a source's id at random, so it names nothing about the URL.
func newID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// playlistKey and guideKey are where a source's URLs live in the keychain.
func playlistKey(id string) string { return "livetv." + id + ".playlist" }

func guideKey(id string) string { return "livetv." + id + ".guide" }

// sourceOfChannel is the source a channel id starts with, or "" when the id
// isn't one of ours. Channel ids are "<source id>:<12 hex>".
func sourceOfChannel(channelID string) string {
	source, _, ok := strings.Cut(channelID, ":")
	if !ok {
		return ""
	}
	return source
}

// cleanName trims a name and cuts it to what the store and the UI hold.
func cleanName(name string) string {
	name = strings.TrimSpace(name)
	if letters := []rune(name); len(letters) > maxNameRunes {
		name = string(letters[:maxNameRunes])
	}
	return name
}

// defaultName is what a source with no name of its own is called: its URL's
// host, or the file's base name without its extension.
func defaultName(playlist string) string {
	if path, isFile := localPath(playlist); isFile {
		base := filepath.Base(path)
		if name := cleanName(strings.TrimSuffix(base, filepath.Ext(base))); name != "" {
			return name
		}
		return "Live TV"
	}
	u, err := url.Parse(playlist)
	if err != nil {
		return "Live TV"
	}
	if name := cleanName(strings.TrimPrefix(u.Hostname(), "www.")); name != "" {
		return name
	}
	return "Live TV"
}
