package main

import (
	"fmt"
	"strings"
)

// allowed are the licences a dependency may have: all permissive, or
// file-level copyleft (MPL) that does not reach Sinag's own code.
var allowed = map[string]bool{
	"0BSD": true, "Apache-2.0": true, "BSD-2-Clause": true, "BSD-3-Clause": true,
	"BlueOak-1.0.0": true, "CC0-1.0": true, "ISC": true, "MIT": true,
	"MPL-2.0": true, "OFL-1.1": true, "Unlicense": true, "Zlib": true,
}

// identify guesses the SPDX id of a licence text. It only needs to be right
// about the permissive licences; anything else is "unknown" and fails the
// audit until someone looks at it.
func identify(text string) string {
	// One space between words: a phrase may be wrapped across lines.
	t := strings.Join(strings.Fields(strings.ToLower(text)), " ")
	has := func(s string) bool { return strings.Contains(t, s) }

	switch {
	// Before the GNU licences: MPL 2.0 names them as its "Secondary
	// Licenses" (#55, anacrolix/torrent).
	case has("mozilla public license") && has("version 2.0"):
		return "MPL-2.0"
	case has("gnu affero general public license"):
		return "AGPL"
	case has("gnu lesser general public license"):
		return "LGPL"
	case has("gnu general public license"):
		return "GPL"
	case has("apache license") && has("version 2.0"):
		return "Apache-2.0"
	case has("sil open font license") && has("version 1.1"):
		return "OFL-1.1"
	case has("this is free and unencumbered software released into the public domain"):
		return "Unlicense"
	case has("permission to use, copy, modify, and/or distribute this software for any purpose"):
		return "ISC"
	case has("redistribution and use in source and binary forms") && has("neither the name"):
		return "BSD-3-Clause"
	case has("redistribution and use in source and binary forms"):
		return "BSD-2-Clause"
	case has("permission is hereby granted, free of charge, to any person obtaining a copy"):
		return "MIT"
	}
	return "unknown"
}

// checkPolicy fails if any dependency has a licence outside the allow list.
func checkPolicy(deps []dep) error {
	var bad []string
	for _, d := range deps {
		if !allowed[d.Licence] {
			bad = append(bad, fmt.Sprintf("  %s %s %s: %s", d.Kind, d.Name, d.Version, d.Licence))
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("dependencies outside the permitted licences (see CONTRIBUTING.md):\n%s", strings.Join(bad, "\n"))
	}
	return nil
}
