package plugins

import (
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strings"
)

// Manifest is a plugin repository's manifest.json: its name, and the
// plugins ("scrapers") in it. Repositories write it two ways, a bare list
// of scrapers or an object with a `scrapers` list; ParseManifest takes both.
type Manifest struct {
	Name     string    `json:"name"`
	Version  string    `json:"version"`
	Scrapers []Scraper `json:"scrapers"`
}

// Scraper is one plugin as a manifest lists it. File is its code's URL,
// resolved against the manifest's.
type Scraper struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Description       string   `json:"description,omitempty"`
	Version           string   `json:"version,omitempty"`
	Author            string   `json:"author,omitempty"`
	SupportedTypes    []string `json:"supportedTypes"`
	Filename          string   `json:"filename"`
	File              string   `json:"file"`
	Enabled           bool     `json:"enabled"`
	Logo              string   `json:"logo,omitempty"`
	ContentLanguage   []string `json:"contentLanguage,omitempty"`
	Formats           []string `json:"formats,omitempty"`
	Limited           bool     `json:"limited,omitempty"`
	DisabledPlatforms []string `json:"disabledPlatforms,omitempty"`
}

// Serves is whether the plugin answers for mediaType ("movie" or "tv").
// Manifests also say "series" for tv and "anime", which Nuvio asks as tv.
// A plugin that lists no types is taken to serve both.
func (s Scraper) Serves(mediaType string) bool {
	if len(s.SupportedTypes) == 0 {
		return true
	}
	for _, t := range s.SupportedTypes {
		t = strings.ToLower(t)
		if t == mediaType || (mediaType == "tv" && (t == "series" || t == "anime")) {
			return true
		}
	}
	return false
}

// ParseManifest reads a manifest fetched from base, resolving each
// plugin's filename against base. Plugins without an id or a file, or with
// a file that isn't http or https, are left out; so are ones for other
// platforms only ("desktop" disabled).
func ParseManifest(data []byte, base string) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m.Scrapers); err != nil {
		if err := json.Unmarshal(data, &m); err != nil {
			return Manifest{}, fmt.Errorf("plugins: not a plugin manifest: %w", err)
		}
	}
	root, err := url.Parse(base)
	if err != nil {
		return Manifest{}, fmt.Errorf("plugins: manifest URL: %w", err)
	}
	kept := m.Scrapers[:0]
	for _, s := range m.Scrapers {
		if s.ID == "" || s.Filename == "" || slices.Contains(s.DisabledPlatforms, "desktop") {
			continue
		}
		ref, err := url.Parse(strings.TrimSpace(s.Filename))
		if err != nil {
			continue
		}
		file := root.ResolveReference(ref)
		if file.Scheme != "http" && file.Scheme != "https" {
			continue
		}
		s.File = file.String()
		if s.Name == "" {
			s.Name = s.ID
		}
		kept = append(kept, s)
	}
	m.Scrapers = kept
	return m, nil
}
