package main

import (
	"regexp"
	"strings"
)

// Titles in the user's TorBox account (read-only: no torrent is added).
// Several releases per title, so addon subtitles meet the timing of a
// release they weren't made for.
type title struct {
	Slug  string
	IMDb  string
	Type  string // movie, series
	S, E  int
	Match *regexp.Regexp // on the file name
	Skip  *regexp.Regexp
	Max   int
}

var mustRe = regexp.MustCompile

var titles = []title{
	{Slug: "dune-2021", IMDb: "tt1160419", Type: "movie", Match: mustRe(`(?i)dune`), Skip: mustRe(`(?i)part.two|messiah|prophecy`), Max: 14},
	{Slug: "thunderbolts", IMDb: "tt20969586", Type: "movie", Match: mustRe(`(?i)thunderbolts`), Max: 6},
	{Slug: "interstellar", IMDb: "tt0816692", Type: "movie", Match: mustRe(`(?i)interstellar`), Max: 5},
	{Slug: "hunger-games", IMDb: "tt1392170", Type: "movie", Match: mustRe(`(?i)hunger.games.2012`), Max: 3},
	{Slug: "shawshank", IMDb: "tt0111161", Type: "movie", Match: mustRe(`(?i)shawshank`), Max: 2},
	{Slug: "black-panther", IMDb: "tt1825683", Type: "movie", Match: mustRe(`(?i)black.panther.(\(?2018|cropped)`), Max: 3},
	{Slug: "endgame", IMDb: "tt4154796", Type: "movie", Match: mustRe(`(?i)endgame`), Max: 3},
	{Slug: "infinity-war", IMDb: "tt4154756", Type: "movie", Match: mustRe(`(?i)infinity.war`), Max: 3},
	{Slug: "hp-dh2", IMDb: "tt1201607", Type: "movie", Match: mustRe(`(?i)deathly.hallows.part.2`), Max: 3},
	{Slug: "spider-verse", IMDb: "tt9362722", Type: "movie", Match: mustRe(`(?i)across.the.spider.verse`), Max: 2},
	{Slug: "hail-mary", IMDb: "tt12042730", Type: "movie", Match: mustRe(`(?i)hail.mary`), Max: 2},
	{Slug: "dark-knight", IMDb: "tt0468569", Type: "movie", Match: mustRe(`(?i)the.dark.knight.\(?2008`), Max: 2},
	{Slug: "mad-max", IMDb: "tt1392190", Type: "movie", Match: mustRe(`(?i)mad.max.fury`), Max: 2},
	{Slug: "logan", IMDb: "tt3315342", Type: "movie", Match: mustRe(`(?i)^logan`), Max: 2},
	{Slug: "fellowship", IMDb: "tt0120737", Type: "movie", Match: mustRe(`(?i)fellowship.of.the.ring`), Max: 2},
	{Slug: "men-in-black", IMDb: "tt0119654", Type: "movie", Match: mustRe(`(?i)^men.in.black.\(1997`), Max: 1},
	{Slug: "burn-after-reading", IMDb: "tt0887883", Type: "movie", Match: mustRe(`(?i)burn.after.reading`), Max: 1},
	{Slug: "avatar-aang", IMDb: "tt18259538", Type: "movie", Match: mustRe(`(?i)avatar.aang`), Max: 3},
	{Slug: "slow-horses-1x01", IMDb: "tt5875444", Type: "series", S: 1, E: 1, Match: mustRe(`(?i)slow.horses.*s01e01|slow.horses.*1x01`), Max: 8},
	{Slug: "ted-lasso-1x01", IMDb: "tt10986410", Type: "series", S: 1, E: 1, Match: mustRe(`(?i)ted.lasso.*s01e01`), Max: 3},
	{Slug: "breaking-bad-1x01", IMDb: "tt0903747", Type: "series", S: 1, E: 1, Match: mustRe(`(?i)breaking.bad.*s01e01`), Max: 3},
	{Slug: "breaking-bad-2x01", IMDb: "tt0903747", Type: "series", S: 2, E: 1, Match: mustRe(`(?i)breaking.bad.*s02e01`), Max: 2},
	{Slug: "the-boys-1x01", IMDb: "tt1190634", Type: "series", S: 1, E: 1, Match: mustRe(`(?i)(the.boys|пацаны).*(s01e01|e01)`), Max: 3},
	{Slug: "summer-pretty-3x01", IMDb: "tt14016500", Type: "series", S: 3, E: 1, Match: mustRe(`(?i)summer.i.turned.pretty.*s03e01`), Max: 3},
	{Slug: "nobody-wants-this-3x01", IMDb: "tt26933824", Type: "series", S: 3, E: 1, Match: mustRe(`(?i)nobody.wants.this.*s03e01`), Max: 3},
	{Slug: "widows-bay-1x01", IMDb: "tt33332385", Type: "series", S: 1, E: 1, Match: mustRe(`(?i)widows.bay.*s01e01`), Max: 2},
	{Slug: "frieren-1x01", IMDb: "tt22248376", Type: "series", S: 1, E: 1, Match: mustRe(`(?i)frieren.*(s01e01|- 01\b)`), Max: 4},
}

type ListFile struct {
	Torrent int64  `json:"torrent"`
	File    int64  `json:"file"`
	Name    string `json:"name"`
	Size    int64  `json:"size"`
}

type Entry struct {
	Key     string `json:"key"` // slug + n
	Slug    string `json:"slug"`
	IMDb    string `json:"imdb"`
	Type    string `json:"type"`
	S       int    `json:"season,omitempty"`
	E       int    `json:"episode,omitempty"`
	Torrent int64  `json:"torrent"`
	File    int64  `json:"file"`
	Name    string `json:"name"`
	Size    int64  `json:"size"`
}

func (e Entry) StremioID() string {
	if e.Type == "series" {
		return e.IMDb + ":" + itoa(e.S) + ":" + itoa(e.E)
	}
	return e.IMDb
}

func selectCorpus(files []ListFile) []Entry {
	var out []Entry
	seen := map[string]bool{}
	for _, t := range titles {
		n := 0
		for _, f := range files {
			low := strings.ToLower(f.Name)
			if !t.Match.MatchString(f.Name) || (t.Skip != nil && t.Skip.MatchString(f.Name)) ||
				strings.Contains(low, "sample") || strings.Contains(low, "trailer") || f.Size < 300<<20 {
				continue
			}
			if !strings.HasSuffix(low, ".mkv") && !strings.HasSuffix(low, ".mp4") {
				continue
			}
			// the same release name in two torrents: keep one
			if seen[low] {
				continue
			}
			seen[low] = true
			n++
			out = append(out, Entry{
				Key: t.Slug + "-" + itoa(n), Slug: t.Slug, IMDb: t.IMDb, Type: t.Type, S: t.S, E: t.E,
				Torrent: f.Torrent, File: f.File, Name: f.Name, Size: f.Size,
			})
			if n >= t.Max {
				break
			}
		}
	}
	return out
}
