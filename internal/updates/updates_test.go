package updates

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

func TestIsRelease(t *testing.T) {
	for version, want := range map[string]bool{
		"0.1.0": true, "1.2.3": true, "v1.2.3": true, "1.0.0-beta.1": true,
		"0.0.0-dev": false, "0.0.0": false, "": false, "1.2": false, "1.2.x": false, "1..3": false,
	} {
		if got := isRelease(version); got != want {
			t.Errorf("isRelease(%q) = %v, want %v", version, got, want)
		}
	}
}

type fakeEngine struct {
	mu        sync.Mutex
	release   *updater.Release
	checkErr  error
	staged    string
	restarted int
}

func (e *fakeEngine) Check(context.Context) (*updater.Release, error) { return e.release, e.checkErr }
func (e *fakeEngine) DownloadAndInstall(context.Context) error        { return nil }
func (e *fakeEngine) DownloadedPath() string                          { return e.staged }
func (e *fakeEngine) Restart(context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.restarted++
	return nil
}

type fakeInstalled struct {
	where  string
	reason Reason
	check  error
	got    []string
}

func (f *fakeInstalled) Where() (string, Reason) { return f.where, f.reason }
func (f *fakeInstalled) Check(staged, target, version string) error {
	f.got = []string{staged, target, version}
	return f.check
}

func newTestService(t *testing.T, version string, engine Engine, inst *fakeInstalled) (*Service, *[]Status) {
	t.Helper()
	s := NewService(version)
	s.key = make(ed25519.PublicKey, ed25519.PublicKeySize)
	s.installed = inst
	s.newEngine = func(string) (Engine, error) { return engine, nil }
	var mu sync.Mutex
	var sent []Status
	s.emit = func(st Status) {
		mu.Lock()
		sent = append(sent, st)
		mu.Unlock()
	}
	if err := s.start("https://example.invalid/feed.json"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.ServiceShutdown() })
	return s, &sent
}

func TestRunDownloadsAndIsReady(t *testing.T) {
	engine := &fakeEngine{
		release: &updater.Release{Version: "0.2.0", Notes: "New", Artifact: updater.Artifact{Size: 100}},
		staged:  "/tmp/wails-update-1/Peli.app",
	}
	inst := &fakeInstalled{where: "/Applications/Peli.app"}
	s, sent := newTestService(t, "0.1.0", engine, inst)

	s.run(context.Background())

	st := s.Status()
	if st.State != Ready || st.Version != "0.2.0" || st.Notes != "New" || st.CheckedAt == 0 {
		t.Fatalf("status = %+v, want ready for 0.2.0", st)
	}
	if want := []string{"/tmp/wails-update-1/Peli.app", "/Applications/Peli.app", "0.2.0"}; !equal(inst.got, want) {
		t.Fatalf("checked %v, want %v", inst.got, want)
	}
	var states []State
	for _, st := range *sent {
		states = append(states, st.State)
	}
	if want := []State{Checking, Downloading, Ready}; !equal(states, want) {
		t.Fatalf("sent %v, want %v", states, want)
	}
	// Ready stays ready: another run doesn't check again.
	engine.checkErr = errors.New("boom")
	s.run(context.Background())
	if s.Status().State != Ready {
		t.Fatalf("a run after ready changed the status to %+v", s.Status())
	}
}

func TestRunRejectsAMismatchedApp(t *testing.T) {
	engine := &fakeEngine{release: &updater.Release{Version: "0.2.0"}, staged: "/tmp/x/Peli.app"}
	inst := &fakeInstalled{where: "/Applications/Peli.app", check: ErrMismatch}
	s, _ := newTestService(t, "0.1.0", engine, inst)

	s.run(context.Background())

	st := s.Status()
	if st.State != Failed || st.Problem == "" {
		t.Fatalf("status = %+v, want failed with a problem", st)
	}
	if err := s.Restart(); !errors.Is(err, ErrNotReady) {
		t.Fatalf("Restart() = %v, want ErrNotReady", err)
	}
}

func TestRunUpToDate(t *testing.T) {
	s, _ := newTestService(t, "0.1.0", &fakeEngine{}, &fakeInstalled{where: "/Applications/Peli.app"})
	s.run(context.Background())
	if st := s.Status(); st.State != UpToDate || st.CheckedAt == 0 {
		t.Fatalf("status = %+v, want up to date", st)
	}
}

func TestRestartWaitsForPlayback(t *testing.T) {
	engine := &fakeEngine{release: &updater.Release{Version: "0.2.0"}, staged: "/tmp/x/Peli.app"}
	s, _ := newTestService(t, "0.1.0", engine, &fakeInstalled{where: "/Applications/Peli.app"})
	playing := true
	UsePlayer(s, func() bool { return playing })
	s.run(context.Background())

	if err := s.Restart(); !errors.Is(err, ErrPlaying) {
		t.Fatalf("Restart() while playing = %v, want ErrPlaying", err)
	}
	if engine.restarted != 0 {
		t.Fatal("restarted while playing")
	}
	playing = false
	if err := s.Restart(); err != nil {
		t.Fatal(err)
	}
	if engine.restarted != 1 {
		t.Fatalf("restarted %d times, want 1", engine.restarted)
	}
}

func TestOff(t *testing.T) {
	for _, tc := range []struct {
		name, version string
		inst          *fakeInstalled
		want          Reason
	}{
		{"development", "0.0.0-dev", &fakeInstalled{where: "/Applications/Peli.app"}, Development},
		{"unstamped", "", &fakeInstalled{where: "/Applications/Peli.app"}, Development},
		{"disk image", "0.1.0", &fakeInstalled{reason: NotInstalled}, NotInstalled},
		{"read-only", "0.1.0", &fakeInstalled{reason: ReadOnly}, ReadOnly},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newTestService(t, tc.version, &fakeEngine{}, tc.inst)
			if st := s.Status(); st.State != Off || st.Reason != tc.want {
				t.Fatalf("status = %+v, want off for %s", st, tc.want)
			}
			if _, err := s.Check(); !errors.Is(err, ErrOff) {
				t.Fatalf("Check() = %v, want ErrOff", err)
			}
		})
	}
}

func TestMarshalError(t *testing.T) {
	for err, want := range map[error]string{
		ErrPlaying: CodePlaying, ErrNotReady: CodeNotReady, ErrOff: CodeOff, errors.New("x"): CodeUnavailable,
	} {
		var got map[string]string
		if err := json.Unmarshal(MarshalError(err), &got); err != nil || got["code"] != want {
			t.Errorf("MarshalError(%v) = %v, want code %q", err, got, want)
		}
	}
}

// A feed server for one release, signed with key unless unsigned is set.
type feedServer struct {
	*httptest.Server
	version  string
	artifact []byte
	sig      []byte
	unsigned bool
}

func newFeedServer(t *testing.T, key ed25519.PrivateKey, version string, artifact []byte) *feedServer {
	t.Helper()
	digest := sha512.Sum512(artifact)
	sig, err := key.Sign(nil, digest[:], &ed25519.Options{Hash: crypto.SHA512})
	if err != nil {
		t.Fatal(err)
	}
	f := &feedServer{version: version, artifact: artifact, sig: sig}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/" + FeedName:
			art := Artifact{
				URL: f.URL + "/Peli.zip", Platform: runtime.GOOS, Arch: runtime.GOARCH,
				Size: int64(len(f.artifact)),
			}
			if !f.unsigned {
				art.SignatureAlgo, art.Signature = SignatureAlgo, base64.StdEncoding.EncodeToString(f.sig)
			}
			_ = json.NewEncoder(w).Encode(Feed{SchemaVersion: 1, Version: f.version, Artifacts: []Artifact{art}})
		case "/Peli.zip":
			_, _ = w.Write(f.artifact)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func TestProviderNeedsASignature(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	srv := newFeedServer(t, key, "0.2.0", []byte("zip"))
	p, err := newProvider(srv.URL+"/"+FeedName, "test")
	if err != nil {
		t.Fatal(err)
	}
	req := updater.CheckRequest{CurrentVersion: "0.1.0", Platform: runtime.GOOS, Arch: runtime.GOARCH}

	rel, err := p.Check(context.Background(), req)
	if err != nil || rel == nil || rel.Version != "0.2.0" {
		t.Fatalf("Check() = %+v, %v; want 0.2.0", rel, err)
	}
	srv.unsigned = true
	if _, err := p.Check(context.Background(), req); !errors.Is(err, ErrUnsigned) {
		t.Fatalf("Check() of an unsigned release = %v, want ErrUnsigned", err)
	}
	// Up to date: nothing to say about signatures.
	srv.version = "0.1.0"
	if rel, err := p.Check(context.Background(), req); rel != nil || err != nil {
		t.Fatalf("Check() for the same version = %+v, %v; want nothing", rel, err)
	}
}

// testHost is the part of the app Wails' updater talks to.
type testHost struct{}

func (testHost) Emit(string, ...any) bool                              { return false }
func (testHost) OnEvent(string, func(any)) func()                      { return func() {} }
func (testHost) OpenWindow(updater.WindowOptions) updater.WindowHandle { return nil }
func (testHost) Quit()                                                 {}

// zipApp is a zip with one Peli.app in it, as dist.sh zip makes.
func zipApp(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{"Peli.app/Contents/Info.plist", "Peli.app/Contents/MacOS/peli"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(name))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// Through Wails' updater: a signed zip downloads and unpacks to Peli.app,
// and one changed after signing, or signed with another key, doesn't.
func TestWailsUpdaterChecksTheSignature(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	app := zipApp(t)

	for _, tc := range []struct {
		name   string
		trust  ed25519.PublicKey
		tamper bool
		ok     bool
	}{
		{"signed", pub, false, true},
		{"changed after signing", pub, true, false},
		{"another key", func() ed25519.PublicKey { p, _, _ := ed25519.GenerateKey(rand.Reader); return p }(), false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newFeedServer(t, key, "0.2.0", app)
			if tc.tamper {
				srv.artifact = append(bytes.Clone(app[:len(app)-1]), app[len(app)-1]^1)
			}
			s := NewService("0.1.0")
			s.key = tc.trust
			engine, err := s.configure(updater.New(testHost{}), srv.URL+"/"+FeedName)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if rel, err := engine.Check(ctx); err != nil || rel == nil {
				t.Fatalf("Check() = %+v, %v", rel, err)
			}
			err = engine.DownloadAndInstall(ctx)
			if !tc.ok {
				if err == nil {
					t.Fatal("DownloadAndInstall() passed")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if staged := engine.DownloadedPath(); filepath.Base(staged) != "Peli.app" {
				t.Fatalf("staged %q, want a Peli.app", staged)
			}
			discard(engine.DownloadedPath())
		})
	}
}

func equal[T comparable](a, b []T) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Without a release key compiled in, updates stay off rather than trust
// nothing in particular.
func TestOffWithoutAKey(t *testing.T) {
	s := NewService("0.1.0")
	s.key = nil
	s.installed = &fakeInstalled{where: "/Applications/Peli.app"}
	s.newEngine = func(string) (Engine, error) { return &fakeEngine{}, nil }
	if err := s.start("https://example.invalid/feed.json"); err != nil {
		t.Fatal(err)
	}
	if st := s.Status(); st.State != Off || st.Reason != Unsupported {
		t.Fatalf("status = %+v, want off", st)
	}
}
