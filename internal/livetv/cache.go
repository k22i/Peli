package livetv

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
)

// What a source's cache folder holds: the parsed playlist with its stream
// URLs (hence 0600), the parsed guide, and what the last refresh made of them.
const (
	filePlaylist = "playlist.json"
	fileGuide    = "guide.json"
	fileStatus   = "status.json"

	folderMode = 0o700
	fileMode   = 0o600
)

// playlistFile is playlist.json: the header's guide URLs, the entries with
// their stream URLs, and each entry's Channel.
type playlistFile struct {
	GuideURLs []string  `json:"guideUrls"`
	Entries   []Entry   `json:"entries"`
	Channels  []Channel `json:"channels"`
}

// guideFile is guide.json: the programmes kept, by our channel id.
type guideFile struct {
	Programmes map[string][]Programme `json:"programmes"`
}

// status is what the last refreshes found, for the frontend and for deciding
// when to refresh again. Times are unix ms; lastTry is the last refresh's
// start, so a failing source is left alone for a while.
type status struct {
	PlaylistAt        int64  `json:"playlistAt"`
	GuideAt           int64  `json:"guideAt"`
	PlaylistError     string `json:"playlistError"`
	GuideError        string `json:"guideError"`
	Channels          int    `json:"channels"`
	GuideChannels     int    `json:"guideChannels"`
	Programmes        int    `json:"programmes"`
	GuideFromPlaylist bool   `json:"guideFromPlaylist"`
	HasGuide          bool   `json:"hasGuide"`
	LastTry           int64  `json:"lastTry"`
}

// loaded is a source kept in memory: its status and what was parsed. The
// playlist's stream URLs are here, so it never leaves the process except
// through Stream.
type loaded struct {
	status   status
	channels []Channel
	entries  []Entry
	index    map[string]int // channel id → index
	guide    map[string][]Programme
}

// put replaces what was parsed of the playlist. index is how a channel id
// finds its entry, since ChannelsOf and ParsePlaylist share an order.
func (l *loaded) put(p playlistFile) {
	l.entries = p.Entries
	l.channels = p.Channels
	l.index = make(map[string]int, len(p.Channels))
	for i, channel := range p.Channels {
		l.index[channel.ID] = i
	}
}

// folder is where a source's cache lives.
func (s *Service) folder(id string) string {
	return filepath.Join(s.cfg.CacheDir, id)
}

// caching says whether a cache folder is configured. Without one the parsed
// results stay in memory only.
func (s *Service) caching() bool { return s.cfg.CacheDir != "" }

// ensureLocked returns id's loaded state, reading it from the disk the first
// time. s.mu must be held: every read and write of a source's state takes it,
// so a refresh and a bound method never see half of each other's work.
func (s *Service) ensureLocked(id string) *loaded {
	if l, ok := s.sources[id]; ok {
		return l
	}
	l := s.readSource(id)
	s.sources[id] = l
	return l
}

// readSource reads id's cache folder. A missing or corrupt file counts as
// empty: the next refresh writes it again.
func (s *Service) readSource(id string) *loaded {
	l := &loaded{index: map[string]int{}, guide: map[string][]Programme{}}
	if !s.caching() {
		return l
	}
	folder := s.folder(id)
	if err := readJSON(filepath.Join(folder, fileStatus), &l.status); err != nil {
		slog.Warn("livetv: cache", "source", id, "part", "status", "code", cacheCode(err))
	}
	var playlist playlistFile
	if err := readJSON(filepath.Join(folder, filePlaylist), &playlist); err != nil {
		slog.Warn("livetv: cache", "source", id, "part", "playlist", "code", cacheCode(err))
	}
	l.put(playlist)
	var guide guideFile
	if err := readJSON(filepath.Join(folder, fileGuide), &guide); err != nil {
		slog.Warn("livetv: cache", "source", id, "part", "guide", "code", cacheCode(err))
	}
	if guide.Programmes != nil {
		l.guide = guide.Programmes
	}
	return l
}

// cachedGuideURLs reads id's cached playlist's guide URLs. A refresh that only
// needs the guide may not have parsed the playlist itself.
func (s *Service) cachedGuideURLs(id string) []string {
	if !s.caching() {
		return nil
	}
	var playlist playlistFile
	if err := readJSON(filepath.Join(s.folder(id), filePlaylist), &playlist); err != nil {
		return nil
	}
	return playlist.GuideURLs
}

// save writes one of a source's cache files. The write goes to a temporary
// file in the same folder and is renamed into place, so a crash leaves the
// last good copy rather than half of this one.
func (s *Service) save(id, name string, v any) error {
	if !s.caching() {
		return nil
	}
	return writeJSON(filepath.Join(s.folder(id), name), v)
}

// forgetCache deletes a source's parsed playlist and guide.
func (s *Service) forgetCache(id string) {
	if !s.caching() {
		return
	}
	if err := os.RemoveAll(s.folder(id)); err != nil {
		slog.Warn("livetv: cache", "source", id, "code", CodeFailed)
	}
}

// cacheCode names a cache read's failure. A missing file is the first run.
func cacheCode(err error) string {
	if errors.Is(err, os.ErrNotExist) {
		return CodeNotFound
	}
	return CodeFailed
}

// readJSON reads a cache file into v.
func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, v); err != nil {
		return err
	}
	return nil
}

// writeJSON writes v to path atomically, readable only by the user: the file
// can hold a channel's stream URL with a username and password in it.
func writeJSON(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	folder := filepath.Dir(path)
	if err := os.MkdirAll(folder, folderMode); err != nil {
		return err
	}
	f, err := os.CreateTemp(folder, ".tmp-*")
	if err != nil {
		return err
	}
	temp := f.Name()
	// A no-op once the rename below has taken the file away.
	defer os.Remove(temp)
	if err := f.Chmod(fileMode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(temp, path)
}
