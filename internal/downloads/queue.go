package downloads

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"slices"

	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/store"
)

// loop runs the queue: the oldest queued download, one at a time.
func (s *Service) loop(ctx context.Context) {
	for {
		j, d := s.pick(ctx)
		if j == nil {
			select {
			case <-s.wake:
				continue
			case <-ctx.Done():
				return
			}
		}
		s.execute(j, d)
		s.endBackgroundIfIdle()
	}
}

// pick takes the oldest queued download and makes it the running job.
func (s *Service) pick(ctx context.Context) (*job, store.Download) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	suspended := s.suspended
	s.mu.Unlock()
	if ctx.Err() != nil || suspended {
		return nil, store.Download{}
	}
	st, err := s.store()
	if err != nil {
		return nil, store.Download{}
	}
	all, err := st.Downloads()
	if err != nil {
		slog.Warn("downloads: reading the queue", "err", err)
		return nil, store.Download{}
	}
	i := slices.IndexFunc(all, func(d store.Download) bool { return d.State == "queued" })
	if i < 0 {
		return nil, store.Download{}
	}
	jctx, cancel := context.WithCancelCause(ctx)
	j := &job{id: all[i].ID, cancel: cancel, done: make(chan struct{})}
	j.ctx = jctx
	s.mu.Lock()
	s.cur = j
	s.mu.Unlock()
	return j, all[i]
}

// execute runs the job to where it stops, and clears it.
func (s *Service) execute(j *job, d store.Download) {
	defer func() {
		j.cancel(nil)
		s.mu.Lock()
		s.cur = nil
		s.mu.Unlock()
		close(j.done)
	}()
	defer safego.Recover("downloads-job")
	st, err := s.store()
	if err != nil {
		return
	}
	r := &runner{s: s, st: st, ctx: j.ctx, d: d, state: d.State}
	r.run()
}

// halt stops the running job when it is id's (any job for ""), by cancelling
// its context with cause and waiting for it to flush and stop. It returns the
// job's id. The caller holds opMu, and changes the record afterwards.
func (s *Service) halt(id string, cause error) (string, bool) {
	s.mu.Lock()
	j := s.cur
	s.mu.Unlock()
	if j == nil || (id != "" && j.id != id) {
		return "", false
	}
	j.cancel(cause)
	<-j.done
	return j.id, true
}

// restate sets a record's state if it is still one a stopped job leaves
// behind: a job that finished just before it was stopped keeps its outcome.
func (s *Service) restate(st *store.Store, id, state, reason string) {
	d, err := st.Download(id)
	if err != nil || d == nil || (d.State != "downloading" && d.State != "waiting" && d.State != "queued") {
		return
	}
	s.setState(st, id, state, reason)
}

// gate says why a job can't use the network now: "offline" or "wifi".
func (s *Service) gate(st *store.Store) string {
	n := s.platform.Network()
	if !n.Online {
		return WaitOffline
	}
	if s.isIOS && n.Expensive {
		if settings, err := st.DeviceSettings(); err == nil && settings.DownloadsWiFiOnly {
			return WaitWiFi
		}
	}
	return ""
}

// room checks that remaining more bytes fit the cap and the disk, returning
// the failure's code or "".
func (s *Service) room(st *store.Store, root string, remaining int64) string {
	remaining = max(remaining, 0)
	settings, err := st.DeviceSettings()
	if err != nil {
		return ""
	}
	used, err := st.DownloadedBytes()
	if err != nil {
		return ""
	}
	if used+remaining > int64(settings.DownloadsCapGB)<<30 {
		return CodeOverCap
	}
	if free, err := s.platform.FreeSpace(root); err == nil && free < remaining+freeMargin {
		return CodeNoSpace
	}
	return ""
}

// recover puts the queue back as it was left: what was running or waiting
// for the network or for background time is queued again. It then removes
// the downloads of profiles that are gone, and the folders no record owns.
func (s *Service) recover(st *store.Store) {
	all, err := st.Downloads()
	if err != nil {
		slog.Warn("downloads: recovery", "err", err)
		return
	}
	profiles, err := st.Profiles()
	if err != nil {
		slog.Warn("downloads: recovery", "err", err)
		return
	}
	known := map[uint64]bool{}
	for _, p := range profiles {
		known[p.ID] = true
	}
	var gone []string
	keep := map[string]bool{}
	roots := map[string]bool{}
	if s.cfg.Root != "" {
		roots[s.cfg.Root] = true
	}
	if settings, err := st.DeviceSettings(); err == nil && settings.DownloadsDir != "" {
		roots[settings.DownloadsDir] = true
	}
	for _, d := range all {
		if !known[d.ProfileID] {
			s.removeFiles(d)
			if err := st.DeleteDownload(d.ID); err == nil {
				gone = append(gone, d.ID)
			}
			continue
		}
		keep[d.ID] = true
		if root := s.rootOf(d); root != "" {
			roots[root] = true
		}
		// A job that was running, or waiting on the network or on time in
		// the background, starts again; the network gate waits again if need
		// be. Paused and failed ones stay as the user left them.
		if d.State == "downloading" || d.State == "waiting" {
			_ = st.UpdateDownload(d.ID, func(d *store.Download) error {
				d.State, d.Reason = "queued", ""
				return nil
			})
		}
	}
	if len(gone) > 0 {
		s.emit(EventRemoved, Removed{IDs: gone})
	}
	for root := range roots {
		sweepFolders(root, keep)
	}
}

// sweepFolders removes the folders in root named like a download id that no
// record owns. Anything else in the folder is the user's.
func sweepFolders(root string, keep map[string]bool) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !hexID.MatchString(e.Name()) || keep[e.Name()] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(root, e.Name())); err != nil {
			slog.Warn("downloads: sweeping", "err", err)
		}
	}
}

// background is the app going to the background (iOS): while a job runs, ask
// for time to keep it going.
func (s *Service) background() {
	s.mu.Lock()
	running := s.cur != nil
	have := s.bgEnd != nil
	s.mu.Unlock()
	if !running || have {
		return
	}
	end := s.platform.Background(s.expiring)
	s.mu.Lock()
	s.bgEnd = end
	s.mu.Unlock()
}

// expiring is the OS about to take the background time back: checkpoint the
// running job, set it to wait as suspended, and give the time back.
func (s *Service) expiring() {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	s.suspended = true
	end := s.bgEnd
	s.bgEnd = nil
	s.mu.Unlock()
	if id, ok := s.halt("", errSuspend); ok {
		if st, err := s.store(); err == nil {
			s.restate(st, id, "waiting", WaitSuspended)
		}
	}
	if end != nil {
		end()
	}
}

// active is the app coming back: suspended jobs are queued again.
func (s *Service) active() {
	s.mu.Lock()
	s.suspended = false
	end := s.bgEnd
	s.bgEnd = nil
	s.mu.Unlock()
	if end != nil {
		end()
	}
	st, err := s.store()
	if err != nil {
		return
	}
	all, err := st.Downloads()
	if err != nil {
		return
	}
	for _, d := range all {
		if d.State == "waiting" && d.Reason == WaitSuspended {
			s.setState(st, d.ID, "queued", "")
		}
	}
	kick(s.wake)
}

// endBackgroundIfIdle gives the background time back once nothing is left to
// run.
func (s *Service) endBackgroundIfIdle() {
	s.mu.Lock()
	end := s.bgEnd
	s.mu.Unlock()
	if end == nil {
		return
	}
	st, err := s.store()
	if err != nil {
		return
	}
	all, err := st.Downloads()
	if err != nil || slices.ContainsFunc(all, func(d store.Download) bool { return d.State == "queued" }) {
		return
	}
	s.mu.Lock()
	end = s.bgEnd
	s.bgEnd = nil
	s.mu.Unlock()
	if end != nil {
		safego.Go("downloads-background-end", end)
	}
}
