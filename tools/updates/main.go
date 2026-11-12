// Command updates makes the signed feed that Peli updates from (#83,
// ADR-0054), for the release pipeline (#80).
//
//	go run ./tools/updates keygen
//	    A new key pair: the private key (base64) on stdout, the public key on
//	    stderr. The public key goes in internal/updates.PublicKey.
//
//	PELI_UPDATE_KEY=… go run ./tools/updates feed -version 0.2.0 \
//	    -base https://github.com/k22i/Peli/releases/download/v0.2.0/ \
//	    -notes notes.md -out bin/peli-update.json \
//	    darwin/arm64=bin/Peli-0.2.0-arm64.zip darwin/amd64=bin/Peli-0.2.0-x86_64.zip
//	    Signs each artifact and writes the feed. -base is where the artifacts
//	    will be: each one's URL is -base plus its file name.
//
//	go run ./tools/updates verify bin/peli-update.json [platform/arch=file ...]
//	    Checks the feed's signatures against internal/updates.PublicKey, with
//	    the files when given, as the app would before installing.
//
// On a Mac the private key is in the login keychain:
//
//	export PELI_UPDATE_KEY=$(security find-generic-password -s "Peli update signing" -w)
package main

import (
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/k22i/Peli/internal/updates"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("updates: ")
	if len(os.Args) < 2 {
		log.Fatal("usage: updates keygen | feed … | verify …")
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = keygen()
	case "feed":
		err = feed(os.Args[2:])
	case "verify":
		err = verify(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		log.Fatal(err)
	}
}

func keygen() error {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	fmt.Println(base64.StdEncoding.EncodeToString(priv.Seed()))
	fmt.Fprintln(os.Stderr, base64.StdEncoding.EncodeToString(pub))
	return nil
}

// artifact is one platform/arch=file argument.
type artifact struct {
	platform, arch, path string
}

func parseArtifacts(args []string) ([]artifact, error) {
	var out []artifact
	for _, arg := range args {
		target, path, ok := strings.Cut(arg, "=")
		platform, arch, ok2 := strings.Cut(target, "/")
		if !ok || !ok2 || platform == "" || arch == "" || path == "" {
			return nil, fmt.Errorf("%q isn't platform/arch=file", arg)
		}
		out = append(out, artifact{platform, arch, path})
	}
	return out, nil
}

func feed(args []string) error {
	fs := flag.NewFlagSet("feed", flag.ExitOnError)
	version := fs.String("version", "", "the release's version, as in Info.plist (no v)")
	base := fs.String("base", "", "the URL the artifacts are published under")
	notesFile := fs.String("notes", "", "release notes (Markdown), optional")
	out := fs.String("out", "", "where to write the feed (default stdout)")
	_ = fs.Parse(args)
	if *version == "" || *base == "" {
		return errors.New("feed needs -version and -base")
	}
	arts, err := parseArtifacts(fs.Args())
	if err != nil {
		return err
	}
	if len(arts) == 0 {
		return errors.New("feed needs at least one platform/arch=file")
	}
	key, err := privateKey()
	if err != nil {
		return err
	}
	if !key.Public().(ed25519.PublicKey).Equal(publicKey()) {
		return errors.New("PELI_UPDATE_KEY isn't the private half of internal/updates.PublicKey")
	}
	// Plain http only on this machine, for trying an update locally.
	baseURL, err := url.Parse(*base)
	loopback := baseURL != nil && (baseURL.Hostname() == "127.0.0.1" || baseURL.Hostname() == "localhost")
	if err != nil || (baseURL.Scheme != "https" && !(loopback && baseURL.Scheme == "http")) {
		return fmt.Errorf("-base %q isn't an https URL", *base)
	}
	if !strings.HasSuffix(baseURL.Path, "/") {
		baseURL.Path += "/"
	}

	f := updates.Feed{
		SchemaVersion: 1,
		Version:       strings.TrimPrefix(*version, "v"),
		Name:          "Peli " + strings.TrimPrefix(*version, "v"),
		PublishedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if *notesFile != "" {
		notes, err := os.ReadFile(*notesFile)
		if err != nil {
			return err
		}
		f.Notes = strings.TrimSpace(string(notes))
	}
	for _, a := range arts {
		digest, size, err := sha512File(a.path)
		if err != nil {
			return err
		}
		if size > updates.MaxArtifact {
			return fmt.Errorf("%s is %d bytes, over Peli's %d", a.path, size, updates.MaxArtifact)
		}
		sig, err := key.Sign(nil, digest, &ed25519.Options{Hash: crypto.SHA512})
		if err != nil {
			return err
		}
		f.Artifacts = append(f.Artifacts, updates.Artifact{
			URL:           baseURL.ResolveReference(&url.URL{Path: url.PathEscape(filepath.Base(a.path))}).String(),
			Platform:      a.platform,
			Arch:          a.arch,
			Size:          size,
			SignatureAlgo: updates.SignatureAlgo,
			Signature:     base64.StdEncoding.EncodeToString(sig),
		})
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if *out == "" {
		_, err = os.Stdout.Write(data)
		return err
	}
	return os.WriteFile(*out, data, 0o644)
}

func verify(args []string) error {
	if len(args) < 1 {
		return errors.New("verify needs the feed")
	}
	data, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	var f updates.Feed
	if err := json.Unmarshal(data, &f); err != nil {
		return err
	}
	arts, err := parseArtifacts(args[1:])
	if err != nil {
		return err
	}
	if f.Version == "" || len(f.Artifacts) == 0 {
		return errors.New("the feed has no version or no artifacts")
	}
	for _, a := range f.Artifacts {
		if a.SignatureAlgo != updates.SignatureAlgo || a.Signature == "" {
			return fmt.Errorf("%s/%s isn't signed", a.Platform, a.Arch)
		}
		fmt.Printf("%s %s/%s %d bytes %s\n", f.Version, a.Platform, a.Arch, a.Size, a.URL)
	}
	for _, local := range arts {
		var found *updates.Artifact
		for i, a := range f.Artifacts {
			if a.Platform == local.platform && a.Arch == local.arch {
				found = &f.Artifacts[i]
			}
		}
		if found == nil {
			return fmt.Errorf("the feed has no %s/%s", local.platform, local.arch)
		}
		digest, size, err := sha512File(local.path)
		if err != nil {
			return err
		}
		sig, err := base64.StdEncoding.DecodeString(found.Signature)
		if err != nil {
			return err
		}
		if size != found.Size {
			return fmt.Errorf("%s is %d bytes, the feed says %d", local.path, size, found.Size)
		}
		if err := ed25519.VerifyWithOptions(publicKey(), digest, sig, &ed25519.Options{Hash: crypto.SHA512}); err != nil {
			return fmt.Errorf("%s: %w", local.path, err)
		}
		fmt.Printf("%s: signature good\n", local.path)
	}
	return nil
}

func privateKey() (ed25519.PrivateKey, error) {
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("PELI_UPDATE_KEY")))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("PELI_UPDATE_KEY isn't set to a base64 Ed25519 private key (see keygen)")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func publicKey() ed25519.PublicKey {
	key, err := base64.StdEncoding.DecodeString(updates.PublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		log.Fatal("internal/updates.PublicKey isn't set to the release key (see keygen)")
	}
	return key
}

func sha512File(path string) ([]byte, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	h := sha512.New()
	n, err := io.Copy(h, f)
	return h.Sum(nil), n, err
}
