package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// dep is one third-party package that ends up in a Sinag release.
type dep struct {
	Kind    string `json:"kind"` // "go" or "npm"
	Name    string `json:"name"`
	Version string `json:"version"`
	Licence string `json:"licence"` // SPDX id, or "unknown"
	Text    string `json:"text"`
}

// collect lists the Go modules linked on any of the three OSes and the
// production npm packages of the frontend.
func collect(root string) ([]dep, error) {
	goDeps, err := goModules(root)
	if err != nil {
		return nil, err
	}
	npmDeps, err := npmPackages(filepath.Join(root, "frontend"))
	if err != nil {
		return nil, err
	}
	deps := append(goDeps, npmDeps...)
	sort.Slice(deps, func(i, j int) bool {
		if deps[i].Kind != deps[j].Kind {
			return deps[i].Kind < deps[j].Kind
		}
		if deps[i].Name != deps[j].Name {
			return strings.ToLower(deps[i].Name) < strings.ToLower(deps[j].Name)
		}
		return deps[i].Version < deps[j].Version
	})
	return deps, nil
}

func goModules(root string) ([]dep, error) {
	type mod struct{ version, dir string }
	mods := map[string]mod{}

	// Dependencies differ per OS (wincred, dbus, ...): take the union.
	for _, goos := range []string{"darwin", "linux", "windows"} {
		cmd := exec.Command("go", "list", "-deps", "-tags", "production,nosqlite",
			"-f", "{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}{{end}}", ".")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GOOS="+goos, "CGO_ENABLED=1")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("go list for %s: %w\n%s", goos, err, stderr.String())
		}
		for line := range strings.SplitSeq(string(out), "\n") {
			parts := strings.Split(strings.TrimSpace(line), "|")
			if len(parts) == 3 {
				mods[parts[0]] = mod{parts[1], parts[2]}
			}
		}
	}

	var deps []dep
	for path, m := range mods {
		text, err := licenceFile(m.dir)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		deps = append(deps, dep{Kind: "go", Name: path, Version: m.version, Licence: identify(text), Text: text})
	}
	return deps, nil
}

func npmPackages(dir string) ([]dep, error) {
	cmd := exec.Command("pnpm", "licenses", "list", "--prod", "--json")
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("pnpm licenses (run `pnpm install` in frontend/ first): %w\n%s", err, stderr.String())
	}

	// {"MIT": [{"name": ..., "versions": [...], "paths": [...]}], ...}
	var byLicence map[string][]struct {
		Name     string   `json:"name"`
		Versions []string `json:"versions"`
		Paths    []string `json:"paths"`
	}
	if err := json.Unmarshal(out, &byLicence); err != nil {
		return nil, fmt.Errorf("pnpm licenses output: %w", err)
	}

	var deps []dep
	for licence, pkgs := range byLicence {
		for _, p := range pkgs {
			for i, version := range p.Versions {
				text, err := licenceFile(p.Paths[i])
				if err != nil {
					// Some packages ship no licence file: say what they declare.
					text = fmt.Sprintf("This package ships no licence file. Its package.json declares the %s licence.", licence)
				}
				deps = append(deps, dep{Kind: "npm", Name: p.Name, Version: version, Licence: licence, Text: text})
			}
		}
	}
	return deps, nil
}

// licenceFile returns the text of the LICENSE/COPYING file in dir.
func licenceFile(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		name := strings.ToLower(e.Name())
		if e.IsDir() || !(strings.HasPrefix(name, "license") || strings.HasPrefix(name, "licence") ||
			strings.HasPrefix(name, "copying") || strings.HasPrefix(name, "unlicense")) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(strings.ReplaceAll(string(b), "\r\n", "\n")), nil
	}
	return "", fmt.Errorf("no licence file in %s", dir)
}
