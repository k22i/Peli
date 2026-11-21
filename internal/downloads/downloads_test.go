package downloads

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/k22i/Peli/internal/markers"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

func TestDownloadsAFile(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)

	d := r.add("tt0903747")
	if d.State != "queued" || d.Root != "" {
		t.Fatalf("added: %+v", d)
	}
	done := r.waitState(d.ID, "done")
	if done.File != d.ID+"/video.mp4" || done.MimeType != "video/mp4" {
		t.Errorf("file %q, type %q", done.File, done.MimeType)
	}
	if done.Bytes != int64(len(payload)) || done.Total != done.Bytes || done.DoneAt == 0 {
		t.Errorf("bytes %d, total %d, doneAt %d", done.Bytes, done.Total, done.DoneAt)
	}
	if !bytes.Equal(r.read(done.File), payload) {
		t.Error("the file isn't the payload")
	}
	if exists(r.path(done.File + ".part")) {
		t.Error("the part file is still there")
	}
	if r.ev.count(EventProgress) == 0 {
		t.Error("no progress events")
	}
	states := r.ev.states(d.ID)
	if states[0] != "queued" || states[len(states)-1] != "done" || !slices.Contains(states, "downloading") {
		t.Errorf("announced %v", states)
	}

	p, err := r.s.Playable(r.profile.ID, "tt0903747")
	if err != nil || p == nil {
		t.Fatalf("playable: %v, %v", p, err)
	}
	if p.Source.URL != r.path(done.File) || p.Source.Origin != "download:"+d.ID ||
		p.Source.ContentType != "video/mp4" || p.Source.Size != int64(len(payload)) {
		t.Errorf("source %+v", p.Source)
	}
}

func TestSendsRangeAndUserAgent(t *testing.T) {
	var agent atomic.Value
	srv := newFileServer(t, nil)
	wrapped := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		agent.Store(req.Header.Get("User-Agent"))
		srv.ServeHTTP(w, req)
	}))
	t.Cleanup(wrapped.Close)
	r := newRig(t)
	r.target.Store(wrapped.URL)
	r.waitState(r.add("v").ID, "done")
	if _, ranges := srv.requests(); len(ranges) != 1 || ranges[0] != "bytes=0-" {
		t.Errorf("ranges %v", ranges)
	}
	if got, _ := agent.Load().(string); got != "Peli/test" {
		t.Errorf("User-Agent %q", got)
	}
}

func TestResumesAfterTheConnectionIsCut(t *testing.T) {
	srv := newFileServer(t, func(f *fileServer) {
		f.cutAfter = func(hit int) int {
			if hit == 1 {
				return 150_000
			}
			return 0
		}
	})
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	done := r.waitState(d.ID, "done")
	if !bytes.Equal(r.read(done.File), payload) {
		t.Error("the file isn't the payload")
	}
	hits, ranges := srv.requests()
	if hits != 2 || ranges[1] == "bytes=0-" || !strings.HasPrefix(ranges[1], "bytes=") {
		t.Errorf("hits %d, ranges %v", hits, ranges)
	}
	if !slices.Contains(r.ev.states(d.ID), "waiting") {
		t.Error("it never waited")
	}
}

func TestResumesAfterPause(t *testing.T) {
	srv := newFileServer(t, holdFirst(100_000))
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	r.waitBytes(d.ID, 100_000)

	if err := r.s.Pause(r.profile.ID, d.ID); err != nil {
		t.Fatal(err)
	}
	paused := r.get(d.ID)
	if paused.State != "paused" {
		t.Fatalf("state %q", paused.State)
	}
	part := r.path(paused.File)
	info, err := os.Stat(part)
	if err != nil || info.Size() < 100_000 || info.Size() != paused.Bytes {
		t.Fatalf("part file %v, %v; record has %d", info, err, paused.Bytes)
	}

	if err := r.s.Resume(r.profile.ID, d.ID); err != nil {
		t.Fatal(err)
	}
	done := r.waitState(d.ID, "done")
	if !bytes.Equal(r.read(done.File), payload) {
		t.Error("the file isn't the payload")
	}
	_, ranges := srv.requests()
	if want := fmt.Sprintf("bytes=%d-", info.Size()); ranges[len(ranges)-1] != want {
		t.Errorf("resumed with %q, want %q", ranges[len(ranges)-1], want)
	}
}

func TestStartsOverWhenRangeIsIgnored(t *testing.T) {
	// The first request is cut; the server then ignores Range and sends it all.
	srv := newFileServer(t, func(f *fileServer) {
		f.cutAfter = func(hit int) int {
			if hit == 1 {
				return 100_000
			}
			return 0
		}
		f.ignoreRange = func(hit int) bool { return hit >= 2 }
	})
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	done := r.waitState(d.ID, "done")
	if !bytes.Equal(r.read(done.File), payload) {
		t.Error("the file isn't the payload")
	}
	if done.Bytes != int64(len(payload)) {
		t.Errorf("bytes %d", done.Bytes)
	}
	if hits, _ := srv.requests(); hits != 2 {
		t.Errorf("%d requests", hits)
	}
}

func TestExpiredLinkIsResolvedAgain(t *testing.T) {
	srv := newFileServer(t, func(f *fileServer) {
		f.status = func(hit int) int {
			if hit == 1 {
				return http.StatusForbidden
			}
			return 0
		}
	})
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	done := r.waitState(d.ID, "done")
	if !bytes.Equal(r.read(done.File), payload) {
		t.Error("the file isn't the payload")
	}
	if n := r.resolves.Load(); n != 2 {
		t.Errorf("resolved %d times, want 2", n)
	}
}

func TestSecondExpiryFails(t *testing.T) {
	for _, status := range []int{401, 403, 404, 410} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			srv := newFileServer(t, func(f *fileServer) {
				f.status = func(int) int { return status }
			})
			r := newRig(t)
			r.serve(srv)
			d := r.add("v")
			failed := r.waitState(d.ID, "failed")
			if failed.Reason != CodeExpired {
				t.Errorf("reason %q", failed.Reason)
			}
			if n := r.resolves.Load(); n != 2 {
				t.Errorf("resolved %d times, want 2", n)
			}
		})
	}
}

func TestSizeMismatchRestartsOnceThenFails(t *testing.T) {
	srv := newFileServer(t, func(f *fileServer) { f.claimTotal = int64(len(payload)) + 100 })
	r := newRig(t)
	r.serve(srv)
	failed := r.waitState(r.add("v").ID, "failed")
	if failed.Reason != CodeSizeMismatch {
		t.Errorf("reason %q", failed.Reason)
	}
	if hits, ranges := srv.requests(); hits != 2 || ranges[1] != "bytes=0-" {
		t.Errorf("hits %d, ranges %v: want one restart from zero", hits, ranges)
	}
}

func TestOverCapFailsBeforeAnyDownload(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	r.resolveFn = func(_ int, req streams.Request) (streams.Source, error) {
		return streams.Source{URL: srv.URL, Origin: req.URL, Size: 60 << 30}, nil
	}
	failed := r.waitState(r.add("v").ID, "failed")
	if failed.Reason != CodeOverCap {
		t.Errorf("reason %q", failed.Reason)
	}
	if hits, _ := srv.requests(); hits != 0 {
		t.Errorf("%d requests", hits)
	}
}

func TestOverCapCountsWhatIsAlreadyDownloaded(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	settings, _ := r.st.DeviceSettings()
	settings.DownloadsCapGB = 10
	if err := r.st.SaveDeviceSettings(settings); err != nil {
		t.Fatal(err)
	}
	// Another download already holds 10 GB.
	other := store.Download{
		ID: strings.Repeat("1", 32), ProfileID: r.profile.ID, VideoID: "old",
		Request: store.DownloadRequest{URL: "https://a.example/x"}, State: "done", Bytes: 10 << 30,
	}
	if err := r.st.PutDownload(other); err != nil {
		t.Fatal(err)
	}
	failed := r.waitState(r.add("v").ID, "failed")
	if failed.Reason != CodeOverCap {
		t.Errorf("reason %q", failed.Reason)
	}
}

func TestNoSpaceFailsBeforeAnyDownload(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	r.plat.mu.Lock()
	r.plat.free = 100 << 20 // under the 1 GiB margin
	r.plat.mu.Unlock()
	failed := r.waitState(r.add("v").ID, "failed")
	if failed.Reason != CodeNoSpace {
		t.Errorf("reason %q", failed.Reason)
	}
	if hits, _ := srv.requests(); hits != 0 {
		t.Errorf("%d requests", hits)
	}
}

func TestNoSpaceForTheSizeOnceKnown(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	r.plat.mu.Lock()
	r.plat.free = 2 << 30
	r.plat.mu.Unlock()
	r.resolveFn = func(_ int, req streams.Request) (streams.Source, error) {
		return streams.Source{URL: srv.URL, Origin: req.URL, Size: 3 << 30}, nil
	}
	failed := r.waitState(r.add("v").ID, "failed")
	if failed.Reason != CodeNoSpace {
		t.Errorf("reason %q", failed.Reason)
	}
}

func TestWaitsForWiFiAndWakes(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t, func(r *rig) { r.s.isIOS = true })
	r.serve(srv)
	r.plat.setNet(Network{Online: true, Expensive: true})

	d := r.add("v")
	waiting := r.waitState(d.ID, "waiting")
	if waiting.Reason != WaitWiFi {
		t.Fatalf("reason %q", waiting.Reason)
	}
	if hits, _ := srv.requests(); hits != 0 {
		t.Errorf("%d requests while on cellular", hits)
	}
	r.plat.setNet(Network{Online: true})
	r.waitState(d.ID, "done")
}

func TestCellularIsFineWhenWiFiOnlyIsOff(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t, func(r *rig) { r.s.isIOS = true })
	r.serve(srv)
	settings, _ := r.st.DeviceSettings()
	settings.DownloadsWiFiOnly = false
	if err := r.st.SaveDeviceSettings(settings); err != nil {
		t.Fatal(err)
	}
	r.plat.setNet(Network{Online: true, Expensive: true})
	r.waitState(r.add("v").ID, "done")
}

func TestExpensiveNetworkIsIgnoredOnTheDesktop(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	r.plat.setNet(Network{Online: true, Expensive: true})
	r.waitState(r.add("v").ID, "done")
}

func TestWaitsOfflineAndWakes(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	r.plat.setNet(Network{})
	d := r.add("v")
	if w := r.waitState(d.ID, "waiting"); w.Reason != WaitOffline {
		t.Fatalf("reason %q", w.Reason)
	}
	r.plat.setNet(Network{Online: true})
	r.waitState(d.ID, "done")
}

func TestUnreachableLinkWaitsAndRetries(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.resolveFn = func(n int, req streams.Request) (streams.Source, error) {
		if n == 1 {
			return streams.Source{}, streams.ErrUnreachable
		}
		return streams.Source{URL: srv.URL, Origin: req.URL}, nil
	}
	d := r.add("v")
	r.waitState(d.ID, "done")
	if !slices.Contains(r.ev.states(d.ID), "waiting") {
		t.Error("it never waited")
	}
}

func TestResolveNoticesFailTheJob(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{streams.ErrCaching, CodeCaching}, {streams.ErrDenied, CodeDenied},
		{streams.ErrBusy, CodeBusy}, {streams.ErrFailed, CodeFailed},
		{streams.ErrNotVideo, CodeNotVideo}, {streams.ErrExpired, CodeExpired},
		{fmt.Errorf("wrapped: %w", streams.ErrDenied), CodeDenied},
	} {
		t.Run(tc.code, func(t *testing.T) {
			r := newRig(t)
			r.resolveFn = func(int, streams.Request) (streams.Source, error) { return streams.Source{}, tc.err }
			failed := r.waitState(r.add("v").ID, "failed")
			if failed.Reason != tc.code {
				t.Errorf("reason %q, want %q", failed.Reason, tc.code)
			}
		})
	}
}

func TestExtensionFromTheLinkWhenTheTypeIsGeneric(t *testing.T) {
	srv := newFileServer(t, func(f *fileServer) { f.ctype = "application/octet-stream" })
	r := newRig(t)
	r.resolveFn = func(_ int, req streams.Request) (streams.Source, error) {
		return streams.Source{URL: srv.URL + "/files/Film.2020.webm?token=1", Origin: req.URL}, nil
	}
	done := r.waitState(r.add("v").ID, "done")
	if !strings.HasSuffix(done.File, "/video.webm") {
		t.Errorf("file %q", done.File)
	}
	srv2 := newFileServer(t, func(f *fileServer) { f.ctype = "application/octet-stream" })
	r2 := newRig(t)
	r2.resolveFn = func(_ int, req streams.Request) (streams.Source, error) {
		return streams.Source{URL: srv2.URL + "/video", Origin: req.URL}, nil
	}
	done = r2.waitState(r2.add("v").ID, "done")
	if !strings.HasSuffix(done.File, "/video.mkv") {
		t.Errorf("file %q, want the .mkv default", done.File)
	}
}

func TestQueueRunsOneJobAtATimeInOrder(t *testing.T) {
	srv := newFileServer(t, func(f *fileServer) { f.holdAfter = func(int) int { return 100_000 } })
	r := newRig(t)
	r.serve(srv)
	a := r.add("a")
	b := r.add("b")
	r.waitBytes(a.ID, 100_000)
	if got := r.get(b.ID).State; got != "queued" {
		t.Errorf("second job is %q while the first runs", got)
	}
	if hits, _ := srv.requests(); hits != 1 {
		t.Errorf("%d requests, want 1", hits)
	}
	if err := r.s.Pause(r.profile.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	r.waitBytes(b.ID, 100_000)
	if got := r.get(a.ID).State; got != "paused" {
		t.Errorf("first job is %q", got)
	}
}

func TestAddIsIdempotentUnlessFailed(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	a := r.add("v")
	b := r.add("v")
	if a.ID != b.ID {
		t.Errorf("second add made %s, not %s", b.ID, a.ID)
	}
	r.waitState(a.ID, "done")
	if c := r.add("v"); c.ID != a.ID || c.State != "done" {
		t.Errorf("add after done: %+v", c)
	}
	if list, _ := r.s.List(r.profile.ID); len(list) != 1 {
		t.Errorf("%d downloads", len(list))
	}
	if !hexID.MatchString(a.ID) {
		t.Errorf("id %q isn't 32 hex characters", a.ID)
	}

	// A failed one is replaced.
	r.resolveFn = func(int, streams.Request) (streams.Source, error) { return streams.Source{}, streams.ErrDenied }
	f1 := r.add("w")
	r.waitState(f1.ID, "failed")
	f2 := r.add("w")
	if f2.ID == f1.ID {
		t.Fatal("a failed download wasn't replaced")
	}
	if d, _ := r.st.Download(f1.ID); d != nil {
		t.Error("the failed record is still there")
	}
	if !slices.Contains(r.ev.removed(), f1.ID) {
		t.Error("no removed event for the failed one")
	}
}

func TestAddRefusesWhatIsNotADownload(t *testing.T) {
	r := newRig(t)
	for name, mutate := range map[string]func(*AddRequest){
		"no video":    func(q *AddRequest) { q.VideoID = "" },
		"no link":     func(q *AddRequest) { q.Request.URL = "" },
		"not http":    func(q *AddRequest) { q.Request.URL = "magnet:?xt=urn:btih:abc" },
		"no profile":  func(q *AddRequest) { q.ProfileID = 0 },
		"no content":  func(q *AddRequest) { q.ContentID = "" },
	} {
		q := r.request("v")
		mutate(&q)
		if _, err := r.s.Add(q); codeOf(err) != CodeInvalid {
			t.Errorf("%s: %v", name, err)
		}
	}
	q := r.request("v")
	q.ProfileID = 999
	if _, err := r.s.Add(q); codeOf(err) != CodeNotFound {
		t.Errorf("unknown profile: %v", err)
	}
}

func TestDeleteStopsAndRemovesFiles(t *testing.T) {
	srv := newFileServer(t, holdFirst(100_000))
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	r.waitBytes(d.ID, 100_000)
	folder := r.path(d.ID)
	if !exists(folder) {
		t.Fatal("no folder while running")
	}
	if err := r.s.Delete(r.profile.ID, []string{d.ID}); err != nil {
		t.Fatal(err)
	}
	if exists(folder) {
		t.Error("the folder is still there")
	}
	if got, _ := r.st.Download(d.ID); got != nil {
		t.Error("the record is still there")
	}
	if !slices.Contains(r.ev.removed(), d.ID) {
		t.Error("no removed event")
	}

	// A finished one too.
	r.target.Store(srv.URL)
	e := r.add("w")
	done := r.waitState(e.ID, "done")
	if err := r.s.Delete(r.profile.ID, []string{e.ID}); err != nil {
		t.Fatal(err)
	}
	if exists(r.path(done.File)) || exists(r.path(e.ID)) {
		t.Error("the finished download's files are still there")
	}
	if err := r.s.Delete(r.profile.ID, []string{e.ID}); codeOf(err) != CodeNotFound {
		t.Errorf("deleting it again: %v", err)
	}
}

func TestDeleteAllRemovesEveryProfilesDownloads(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	other, err := r.st.CreateProfile(store.Profile{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	a := r.add("a")
	q := r.request("b")
	q.ProfileID = other.ID
	b, err := r.s.Add(q)
	if err != nil {
		t.Fatal(err)
	}
	r.waitState(a.ID, "done")
	r.waitState(b.ID, "done")
	if err := r.s.DeleteAll(r.profile.ID); err != nil {
		t.Fatal(err)
	}
	if all, _ := r.st.Downloads(); len(all) != 0 {
		t.Errorf("%d downloads left", len(all))
	}
	if entries, _ := os.ReadDir(r.root); len(entries) != 0 {
		t.Errorf("%d folders left", len(entries))
	}
}

func TestProfilesSeeOnlyTheirOwn(t *testing.T) {
	r := newRig(t, noStart)
	other, _ := r.st.CreateProfile(store.Profile{Name: "Other"})
	d := r.add("v")
	if _, err := r.s.Get(other.ID, d.ID); codeOf(err) != CodeNotFound {
		t.Errorf("get: %v", err)
	}
	if err := r.s.Pause(other.ID, d.ID); codeOf(err) != CodeNotFound {
		t.Errorf("pause: %v", err)
	}
	if err := r.s.Resume(other.ID, d.ID); codeOf(err) != CodeNotFound {
		t.Errorf("resume: %v", err)
	}
	if err := r.s.Delete(other.ID, []string{d.ID}); codeOf(err) != CodeNotFound {
		t.Errorf("delete: %v", err)
	}
	if list, err := r.s.List(other.ID); err != nil || len(list) != 0 {
		t.Errorf("list: %v, %v", list, err)
	}
	if got, err := r.s.Get(r.profile.ID, d.ID); err != nil || got.ID != d.ID {
		t.Errorf("owner's get: %v, %v", got, err)
	}
}

func TestKidsSeeAndAddOnlyAllowedAddons(t *testing.T) {
	r := newRig(t, noStart)
	index := 3
	kid, err := r.st.CreateProfile(store.Profile{Name: "Kid", NuvioIndex: &index, PinEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range []error{
		r.st.SetKids(kid.ID, true),
		r.st.SetAddons(kid.ID, []store.Addon{{URL: addonA, Enabled: true}, {URL: addonB, Enabled: true}}),
		r.st.SetKidsScope(kid.ID, store.KidsScope{Addons: []string{addonA}}),
	} {
		if step != nil {
			t.Fatal(step)
		}
	}
	q := r.request("ok")
	q.ProfileID = kid.ID
	allowed, err := r.s.Add(q)
	if err != nil {
		t.Fatal(err)
	}
	q = r.request("no")
	q.ProfileID, q.MetaAddon = kid.ID, addonB
	if _, err := r.s.Add(q); codeOf(err) != CodeNotAllowed {
		t.Errorf("add from an addon outside the list: %v", err)
	}
	// One that got in some other way (the allow-list changed since).
	hidden := store.Download{
		ID: strings.Repeat("2", 32), ProfileID: kid.ID, VideoID: "hidden", MetaAddon: addonB,
		Request: store.DownloadRequest{URL: "https://a.example/x"}, State: "done", File: "x/video.mkv",
	}
	if err := r.st.PutDownload(hidden); err != nil {
		t.Fatal(err)
	}

	list, err := r.s.List(kid.ID)
	if err != nil || len(list) != 1 || list[0].ID != allowed.ID {
		t.Errorf("list: %v, %v", list, err)
	}
	if _, err := r.s.Get(kid.ID, hidden.ID); codeOf(err) != CodeNotFound {
		t.Errorf("get hidden: %v", err)
	}
	if p, err := r.s.Playable(kid.ID, "hidden"); p != nil || err != nil {
		t.Errorf("playable hidden: %v, %v", p, err)
	}
	if err := r.s.DeleteAll(kid.ID); codeOf(err) != CodeKids {
		t.Errorf("delete all: %v", err)
	}
	if _, err := r.s.ChooseFolder(kid.ID); codeOf(err) != CodeKids {
		t.Errorf("choose folder: %v", err)
	}
	// It may pause and delete its own.
	if err := r.s.Pause(kid.ID, allowed.ID); err != nil {
		t.Errorf("pause: %v", err)
	}
	if err := r.s.Delete(kid.ID, []string{allowed.ID}); err != nil {
		t.Errorf("delete: %v", err)
	}
}

func TestRecoveryQueuesInterruptedJobsAndSweeps(t *testing.T) {
	r := newRig(t, noStart)
	put := func(id, state, reason string, profile uint64) {
		t.Helper()
		err := r.st.PutDownload(store.Download{
			ID: id, ProfileID: profile, VideoID: id, State: state, Reason: reason,
			Request: store.DownloadRequest{URL: "https://a.example/x"},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	id := func(c string) string { return strings.Repeat(c, 32) }
	put(id("1"), "downloading", "", r.profile.ID)
	put(id("2"), "waiting", WaitSuspended, r.profile.ID)
	put(id("3"), "waiting", WaitOffline, r.profile.ID)
	put(id("4"), "paused", "", r.profile.ID)
	put(id("5"), "failed", CodeExpired, r.profile.ID)
	put(id("6"), "done", "", r.profile.ID)
	put(id("7"), "queued", "", 999) // a profile that is gone

	mkdir := func(name string) {
		t.Helper()
		if err := os.MkdirAll(r.path(name+"/inner"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{id("1"), id("7"), id("a"), "notes", strings.Repeat("D", 32), strings.Repeat("e", 31)} {
		mkdir(name)
	}
	if err := os.WriteFile(r.path(id("b")+".txt"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}

	r.s.recover(r.st)

	for c, want := range map[string]string{"1": "queued", "2": "queued", "3": "queued", "4": "paused", "5": "failed", "6": "done"} {
		if got := r.get(id(c)).State; got != want {
			t.Errorf("download %s is %q, want %q", c, got, want)
		}
	}
	if got := r.get(id("5")).Reason; got != CodeExpired {
		t.Errorf("a failed download lost its reason: %q", got)
	}
	if d, _ := r.st.Download(id("7")); d != nil {
		t.Error("a gone profile's download is still there")
	}
	if !slices.Contains(r.ev.removed(), id("7")) {
		t.Error("no removed event for it")
	}
	for name, want := range map[string]bool{
		id("1"): true, id("7"): false, id("a"): false, "notes": true,
		strings.Repeat("D", 32): true, strings.Repeat("e", 31): true, id("b") + ".txt": true,
	} {
		if got := exists(r.path(name)); got != want {
			t.Errorf("%s exists: %v, want %v", name, got, want)
		}
	}
}

func TestRecoveryRunsAtStartup(t *testing.T) {
	srv := newFileServer(t, nil)
	var seeded string
	r := newRig(t, func(r *rig) {
		seeded = strings.Repeat("9", 32)
		err := r.st.PutDownload(store.Download{
			ID: seeded, ProfileID: r.profile.ID, VideoID: "v", State: "downloading",
			Request: store.DownloadRequest{URL: "https://a.example/x"}, CreatedAt: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		r.target.Store(srv.URL)
	})
	r.waitState(seeded, "done")
}

func TestPlayable(t *testing.T) {
	srv := newFileServer(t, nil)
	subs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/en.vtt":
			fmt.Fprint(w, "WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n")
		case "/big.srt":
			w.Write(make([]byte, maxSubtitle+1))
		default:
			http.NotFound(w, req)
		}
	}))
	t.Cleanup(subs.Close)

	var title markers.Title
	r := newRig(t, func(r *rig) {
		r.s.cfg.Markers = func(_ context.Context, t markers.Title) ([]markers.Segment, error) {
			title = t
			return []markers.Segment{{Kind: "intro", Start: 5, End: 65}}, nil
		}
	})
	r.serve(srv)
	q := r.request("tt0903747:1:2")
	q.ContentType, q.Season, q.Episode = "series", 1, 2
	q.Subtitles = []SubtitleRef{
		{URL: subs.URL + "/en.vtt", Lang: "en", Title: "English"},
		{URL: subs.URL + "/missing.srt", Lang: "fr", Title: "French"},
		{URL: subs.URL + "/big.srt", Lang: "de", Title: "German"},
		{URL: "ftp://x/y.srt", Lang: "es", Title: "Spanish"}, // not http: dropped by Add
	}
	d, err := r.s.Add(q)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Subtitles) != 3 {
		t.Fatalf("%d subtitles kept", len(d.Subtitles))
	}

	// Not playable before it's done.
	if p, err := r.s.Playable(r.profile.ID, q.VideoID); err == nil && p != nil && p.Download.State != "done" {
		t.Errorf("playable while %s", p.Download.State)
	}
	done := r.waitState(d.ID, "done")

	if done.Subtitles[0].File != d.ID+"/subs/0.vtt" || done.Subtitles[1].File != "" || done.Subtitles[2].File != "" {
		t.Errorf("subtitle files %+v", done.Subtitles)
	}
	if !strings.Contains(string(r.read(done.Subtitles[0].File)), "hello") {
		t.Error("the subtitle wasn't saved")
	}
	if title != (markers.Title{IMDbID: "tt0903747", Season: 1, Episode: 2}) {
		t.Errorf("markers asked for %+v", title)
	}
	if len(done.Segments) != 1 || done.Segments[0].Kind != "intro" {
		t.Errorf("segments %+v", done.Segments)
	}

	p, err := r.s.Playable(r.profile.ID, q.VideoID)
	if err != nil || p == nil {
		t.Fatalf("playable: %v, %v", p, err)
	}
	if len(p.Subtitles) != 1 || p.Subtitles[0].Lang != "en" || p.Subtitles[0].Title != "English" ||
		!strings.HasPrefix(p.Subtitles[0].URL, "file://") || !strings.HasSuffix(p.Subtitles[0].URL, "/subs/0.vtt") {
		t.Errorf("subtitles %+v", p.Subtitles)
	}
	if len(p.Segments) != 1 || p.Segments[0] != (markers.Segment{Kind: "intro", Start: 5, End: 65}) {
		t.Errorf("segments %+v", p.Segments)
	}

	// Gone from disk: not playable.
	if err := os.Remove(p.Source.URL); err != nil {
		t.Fatal(err)
	}
	if p, err := r.s.Playable(r.profile.ID, q.VideoID); p != nil || err != nil {
		t.Errorf("playable without its file: %v, %v", p, err)
	}
	if p, err := r.s.Playable(r.profile.ID, "unknown"); p != nil || err != nil {
		t.Errorf("playable for another video: %v, %v", p, err)
	}
}

func TestMarkersOnlyForIMDbTitles(t *testing.T) {
	srv := newFileServer(t, nil)
	asked := false
	r := newRig(t, func(r *rig) {
		r.s.cfg.Markers = func(_ context.Context, _ markers.Title) ([]markers.Segment, error) {
			asked = true
			return nil, errors.New("not reached")
		}
	})
	r.serve(srv)
	q := r.request("kitsu:1:1")
	q.ContentID = "kitsu:1"
	d, err := r.s.Add(q)
	if err != nil {
		t.Fatal(err)
	}
	r.waitState(d.ID, "done")
	if asked {
		t.Error("asked IntroDB for a Kitsu title")
	}
}

func TestShutdownCheckpointsTheRunningJob(t *testing.T) {
	srv := newFileServer(t, holdFirst(100_000))
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	r.waitBytes(d.ID, 100_000)
	if err := r.s.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	got := r.get(d.ID)
	if got.State != "queued" {
		t.Errorf("state %q, want queued", got.State)
	}
	if info, err := os.Stat(r.path(got.File)); err != nil || info.Size() != got.Bytes || got.Bytes < 100_000 {
		t.Errorf("part file %v, %v; record has %d", info, err, got.Bytes)
	}
}

func TestSuspendsInTheBackgroundAndResumesWhenActive(t *testing.T) {
	srv := newFileServer(t, holdFirst(100_000))
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	r.waitBytes(d.ID, 100_000)

	background, active, _ := r.plat.callbacks()
	if background == nil || active == nil {
		t.Fatal("the lifecycle isn't watched")
	}
	background()
	if bg, _ := r.plat.counts(); bg != 1 {
		t.Fatalf("background time asked %d times", bg)
	}
	_, _, expiring := r.plat.callbacks()
	expiring()

	suspended := r.get(d.ID)
	if suspended.State != "waiting" || suspended.Reason != WaitSuspended {
		t.Fatalf("state %q (%q)", suspended.State, suspended.Reason)
	}
	if _, ended := r.plat.counts(); ended != 1 {
		t.Errorf("background time ended %d times", ended)
	}
	if info, err := os.Stat(r.path(suspended.File)); err != nil || info.Size() != suspended.Bytes {
		t.Errorf("part file %v, %v; record has %d", info, err, suspended.Bytes)
	}

	// Nothing starts while suspended, even a new download.
	r.add("w")
	if hits, _ := srv.requests(); hits != 1 {
		t.Errorf("%d requests while suspended", hits)
	}

	active()
	done := r.waitState(d.ID, "done")
	if !bytes.Equal(r.read(done.File), payload) {
		t.Error("the file isn't the payload")
	}
}

func TestBackgroundTimeEndsWhenTheQueueIsEmpty(t *testing.T) {
	srv := newFileServer(t, holdFirst(100_000))
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	r.waitBytes(d.ID, 100_000)
	background, _, _ := r.plat.callbacks()
	background()
	// Let the held request go: it is cut short, and the retry is served whole.
	srv.unhold()
	r.waitState(d.ID, "done")
	waitFor(t, "background time to end", func() bool {
		_, ended := r.plat.counts()
		return ended == 1
	})
}

func TestChooseFolderSavesIt(t *testing.T) {
	r := newRig(t)
	folder := t.TempDir()
	r.plat.mu.Lock()
	r.plat.folder = folder
	r.plat.mu.Unlock()
	got, err := r.s.ChooseFolder(r.profile.ID)
	if err != nil || got != folder {
		t.Fatalf("got %q, %v", got, err)
	}
	if settings, _ := r.st.DeviceSettings(); settings.DownloadsDir != folder {
		t.Errorf("saved %q", settings.DownloadsDir)
	}
	u, err := r.s.Usage()
	if err != nil || u.Dir != folder || u.Cap != 50<<30 || u.Free != 500<<30 {
		t.Errorf("usage %+v, %v", u, err)
	}

	// Cancelled: nothing changes.
	r.plat.mu.Lock()
	r.plat.folder = ""
	r.plat.mu.Unlock()
	if got, err := r.s.ChooseFolder(r.profile.ID); got != "" || err != nil {
		t.Errorf("cancelled: %q, %v", got, err)
	}
	if settings, _ := r.st.DeviceSettings(); settings.DownloadsDir != folder {
		t.Errorf("cancelling changed it to %q", settings.DownloadsDir)
	}
}

func TestNewJobsUseTheChosenFolder(t *testing.T) {
	srv := newFileServer(t, nil)
	r := newRig(t)
	r.serve(srv)
	folder := t.TempDir()
	settings, _ := r.st.DeviceSettings()
	settings.DownloadsDir = folder
	if err := r.st.SaveDeviceSettings(settings); err != nil {
		t.Fatal(err)
	}
	d := r.add("v")
	done := r.waitState(d.ID, "done")
	if done.Root != folder || !exists(folder+"/"+done.File) {
		t.Errorf("root %q, file %q", done.Root, done.File)
	}
	p, err := r.s.Playable(r.profile.ID, "v")
	if err != nil || p == nil || !strings.HasPrefix(p.Source.URL, folder) {
		t.Errorf("playable %+v, %v", p, err)
	}
}

func TestUsageCountsPartialFiles(t *testing.T) {
	srv := newFileServer(t, holdFirst(100_000))
	r := newRig(t)
	r.serve(srv)
	d := r.add("v")
	r.waitBytes(d.ID, 100_000)
	u, err := r.s.Usage()
	if err != nil || u.Used < 100_000 || u.Dir != r.root {
		t.Errorf("usage %+v, %v", u, err)
	}
	if n := r.s.Network(); !n.Online || n.Expensive {
		t.Errorf("network %+v", n)
	}
}

func TestMarshalError(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{ErrUnsupported, "unsupported"},
		{fmt.Errorf("x: %w", ErrUnsupported), "unsupported"},
		{fail(CodeKids), "kids_profile"},
		{streams.ErrExpired, "expired"},
		{streams.ErrCaching, "caching"},
		{streams.ErrUnreachable, "unreachable"},
		{streams.ErrTimeout, "timeout"},
		{store.ErrDownloadNotFound, "not_found"},
		{errors.New("boom"), "failed"},
	} {
		var got struct{ Code, Message string }
		if err := json.Unmarshal(MarshalError(tc.err), &got); err != nil || got.Code != tc.code {
			t.Errorf("%v: %+v, %v", tc.err, got, err)
		}
	}
}
