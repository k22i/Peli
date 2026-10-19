// Command notices generates Sinag's third-party notices and audits a release
// for GPL-only components (#18).
//
//	go run ./tools/notices                  rewrite THIRD_PARTY_NOTICES.md and internal/licences/notices.json
//	go run ./tools/notices -audit           fail on a dependency that is not permissively licensed
//	go run ./tools/notices -audit -bundle D also scan the files under D for GPL or non-free FFmpeg builds
//
// Run it from the repository root, after `pnpm install` in frontend/.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	audit := flag.Bool("audit", false, "check the licences instead of writing the notices")
	bundle := flag.String("bundle", "", "with -audit: a release bundle to scan for GPL or non-free libmpv/FFmpeg builds")
	flag.Parse()

	if err := run(*audit, *bundle); err != nil {
		fmt.Fprintln(os.Stderr, "notices:", err)
		os.Exit(1)
	}
}

func run(audit bool, bundle string) error {
	deps, err := collect(".")
	if err != nil {
		return err
	}
	if err := checkPolicy(deps); err != nil {
		return err
	}

	if audit {
		fmt.Printf("%d dependencies, all permissively licensed\n", len(deps))
		if bundle == "" {
			return nil
		}
		return auditBundle(bundle, os.Stdout)
	}

	n, err := build(".", deps)
	if err != nil {
		return err
	}
	if err := os.WriteFile("THIRD_PARTY_NOTICES.md", []byte(n.markdown()), 0o644); err != nil {
		return err
	}
	js, err := n.json()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join("internal", "licences", "notices.json"), js, 0o644)
}
