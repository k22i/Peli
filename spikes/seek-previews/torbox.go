package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
)

// Entry is a release in the subtitle spike's corpus: files already in the
// user's TorBox account, so asking for a link adds nothing to it.
type Entry struct {
	Key     string `json:"key"`
	Name    string `json:"name"`
	Torrent int64  `json:"torrent"`
	File    int64  `json:"file"`
	Size    int64  `json:"size"`
}

func corpusEntry(key string) (Entry, error) {
	b, err := os.ReadFile("../subtitle-autosync/results/corpus.json")
	if err != nil {
		return Entry{}, err
	}
	var all []Entry
	if err := json.Unmarshal(b, &all); err != nil {
		return Entry{}, err
	}
	for _, e := range all {
		if e.Key == key {
			return e, nil
		}
	}
	return Entry{}, fmt.Errorf("no corpus entry %q", key)
}

// torboxLink asks TorBox for a CDN link to a file already in the account
// (read-only). The link carries a token: it stays in memory.
func torboxLink(ctx context.Context, e Entry) (string, error) {
	key := os.Getenv("TORBOX_API_KEY")
	if key == "" {
		return "", errors.New("TORBOX_API_KEY not set")
	}
	q := url.Values{"token": {key}, "torrent_id": {strconv.FormatInt(e.Torrent, 10)},
		"file_id": {strconv.FormatInt(e.File, 10)}, "redirect": {"false"}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.torbox.app/v1/api/torrents/requestdl?"+q.Encode(), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", errors.New("torbox unreachable")
	}
	defer resp.Body.Close()
	var body struct {
		Success bool   `json:"success"`
		Data    string `json:"data"`
		Detail  string `json:"detail"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	if !body.Success || body.Data == "" {
		return "", fmt.Errorf("torbox: %s", body.Detail)
	}
	return body.Data, nil
}

func listen() net.Listener {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	return ln
}
