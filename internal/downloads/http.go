package downloads

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/k22i/Peli/internal/markers"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

// What one attempt at the file came to.
type result int

const (
	rStopped result = iota // the context was cancelled; the caller sets the state
	rDone
	rFailed
	rRetry   // again at once: a new link, or a restart from zero
	rNetwork // wait, then resume from the part file
)

const (
	maxSubtitle = 5 << 20
	chunk       = 256 << 10
	// The last few seconds the rate is measured over.
	rateSamples = 8
)

// runner is one run of one download: from the job's start to where it stops.
type runner struct {
	s     *Service
	st    *store.Store
	ctx   context.Context
	d     store.Download
	state string // the record's state, as this run last set it
	root  string

	src      streams.Source
	haveSrc  bool
	reresolv bool // the link has been resolved again once
	restart  bool // restarted from zero once

	have     int64 // bytes of the part file
	lastEmit time.Time
	lastSave time.Time
	samples  []sample
}

type sample struct {
	at    time.Time
	bytes int64
}

// run is the whole run: set up, then attempt until it is done, failed or
// stopped, waiting out the network between attempts.
func (r *runner) run() {
	defer r.flush()
	s := r.s
	r.root = s.rootOf(r.d)
	if r.root == "" {
		r.fail(CodeFailed)
		return
	}
	if err := s.platform.Prepare(r.root); err != nil {
		slog.Warn("downloads: preparing the folder", "err", err)
		r.fail(CodeFailed)
		return
	}
	if err := os.MkdirAll(filepath.Join(r.root, r.d.ID), 0o700); err != nil {
		r.fail(r.diskCode(err))
		return
	}
	r.have = r.partSize()
	r.d.Bytes = r.have
	if code := s.room(r.st, r.root, r.remaining()); code != "" {
		r.fail(code)
		return
	}
	r.setState("downloading", "")
	r.extras()

	delay := s.backoffMin
	for r.ctx.Err() == nil {
		if reason := s.gate(r.st); reason != "" {
			if !r.wait(reason, s.backoffMax) {
				return
			}
			continue
		}
		before := r.have
		switch r.attempt() {
		case rDone, rFailed, rStopped:
			return
		case rRetry:
		case rNetwork:
			if r.have > before {
				delay = s.backoffMin
			}
			if !r.wait(WaitOffline, delay) {
				return
			}
			delay = min(delay*2, s.backoffMax)
		}
	}
}

func (r *runner) remaining() int64 {
	if r.d.Total > 0 {
		return r.d.Total - r.have
	}
	return 0
}

// partFile is where the bytes go while the job runs.
func (r *runner) partFile() string {
	file := r.d.File
	if file == "" {
		return ""
	}
	if !strings.HasSuffix(file, ".part") {
		file += ".part"
	}
	return filepath.Join(r.root, filepath.FromSlash(file))
}

func (r *runner) partSize() int64 {
	if p := r.partFile(); p != "" {
		if info, err := os.Stat(p); err == nil {
			return info.Size()
		}
	}
	return 0
}

func (r *runner) truncate() {
	if p := r.partFile(); p != "" {
		_ = os.Truncate(p, 0)
	}
	r.have = 0
}

func (r *runner) setState(state, reason string) {
	if r.state == state && r.d.Reason == reason {
		return
	}
	r.state, r.d.Reason = state, reason
	r.s.setState(r.st, r.d.ID, state, reason)
}

// fail ends the run with a reason.
func (r *runner) fail(code string) result {
	r.flush()
	r.state, r.d.Reason = "failed", code
	r.s.setState(r.st, r.d.ID, "failed", code)
	return rFailed
}

// diskCode is no_space for a full disk, failed for any other write error.
func (r *runner) diskCode(err error) string {
	if diskFull(err) {
		return CodeNoSpace
	}
	slog.Warn("downloads: writing", "err", err)
	return CodeFailed
}

// wait sets the job waiting and sleeps until d passes, the network changes
// or the job is stopped; false when stopped.
func (r *runner) wait(reason string, d time.Duration) bool {
	r.flush()
	r.setState("waiting", reason)
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-r.s.netWake:
		return true
	case <-r.ctx.Done():
		return false
	}
}

// flush writes the progress to the store.
func (r *runner) flush() {
	r.lastSave = time.Now()
	if r.d.ID == "" {
		return
	}
	err := r.st.SetDownloadProgress(r.d.ID, r.have, r.d.Total)
	if err != nil && !errors.Is(err, store.ErrDownloadNotFound) {
		slog.Warn("downloads: saving progress", "err", err)
	}
}

// tick sends progress and saves it, as often as they are due.
func (r *runner) tick(force bool) {
	now := time.Now()
	if force || now.Sub(r.lastEmit) >= r.s.progressEvery {
		if len(r.samples) == 0 {
			r.samples = append(r.samples, sample{now, r.have})
		}
		old := r.samples[0]
		var rate int64
		if dt := now.Sub(old.at).Seconds(); dt > 0 {
			rate = int64(float64(r.have-old.bytes) / dt)
		}
		r.samples = append(r.samples, sample{now, r.have})
		if len(r.samples) > rateSamples {
			r.samples = r.samples[len(r.samples)-rateSamples:]
		}
		r.lastEmit = now
		r.s.emit(EventProgress, Progress{ID: r.d.ID, Bytes: r.have, Total: r.d.Total, Rate: max(rate, 0)})
	}
	if now.Sub(r.lastSave) >= r.s.saveEvery {
		r.flush()
	}
}

// netError turns a transport failure into the result: stopped when the job
// was cancelled, otherwise a network wait.
func (r *runner) netError() result {
	if r.ctx.Err() != nil {
		return rStopped
	}
	return rNetwork
}

// attempt fetches from where the part file ends, until the file is whole.
func (r *runner) attempt() result {
	s := r.s
	r.setState("downloading", "")
	if !r.haveSrc {
		src, err := s.cfg.Resolve(r.ctx, streams.Request{URL: r.d.Request.URL, Headers: r.d.Request.Headers})
		if err != nil {
			if r.ctx.Err() != nil {
				return rStopped
			}
			switch code := codeOf(err); code {
			case CodeUnreachable, CodeTimeout:
				return rNetwork
			default:
				return r.fail(code)
			}
		}
		r.src, r.haveSrc = src, true
		if r.d.Total == 0 && src.Size > 0 {
			r.d.Total = src.Size
		}
		if code := s.room(r.st, r.root, r.remaining()); code != "" {
			return r.fail(code)
		}
	}
	if r.d.Total > 0 && r.have > r.d.Total {
		r.truncate()
	}
	if r.d.Total > 0 && r.have == r.d.Total && r.d.File != "" {
		return r.finish()
	}

	// A watchdog cuts a body that stops coming.
	actx, cancel := context.WithCancel(r.ctx)
	defer cancel()
	stall := time.AfterFunc(s.stall, cancel)
	defer stall.Stop()

	req, err := http.NewRequestWithContext(actx, http.MethodGet, r.src.URL, nil)
	if err != nil {
		return r.fail(CodeInvalid)
	}
	for name, value := range r.src.Headers {
		req.Header.Set(name, value)
	}
	req.Header.Set("User-Agent", userAgent(r.src, s.cfg.Version))
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Range", "bytes="+strconv.FormatInt(r.have, 10)+"-")
	resp, err := s.httpc.Do(req)
	if err != nil {
		return r.netError()
	}
	defer resp.Body.Close()

	switch status := resp.StatusCode; {
	case status == http.StatusUnauthorized, status == http.StatusForbidden,
		status == http.StatusNotFound, status == http.StatusGone:
		// The link expired: resolve once more in this run.
		if r.reresolv {
			return r.fail(CodeExpired)
		}
		r.reresolv, r.haveSrc = true, false
		return rRetry
	case status == http.StatusRequestedRangeNotSatisfiable:
		if r.have > 0 {
			r.truncate()
			return rRetry
		}
		return r.fail(CodeFailed)
	case status == http.StatusTooManyRequests, status >= 500:
		return rNetwork
	case status != http.StatusOK && status != http.StatusPartialContent:
		return r.fail(CodeFailed)
	}

	var total int64
	if resp.StatusCode == http.StatusPartialContent {
		start, all, ok := parseContentRange(resp.Header.Get("Content-Range"))
		if !ok || start != r.have {
			// Not where we asked: start over rather than splice.
			return r.restartOrFail()
		}
		total = all
	} else {
		// 200: the server ignored Range and sent the whole file.
		if r.have > 0 {
			r.truncate()
		}
		total = max(resp.ContentLength, 0)
	}
	if total <= 0 {
		total = r.src.Size
	}
	if total > 0 {
		r.d.Total = total
	}
	if r.d.File == "" {
		r.setFile(resp)
	}
	if code := s.room(r.st, r.root, r.remaining()); code != "" {
		return r.fail(code)
	}

	f, err := os.OpenFile(r.partFile(), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return r.fail(r.diskCode(err))
	}
	if _, err := f.Seek(r.have, io.SeekStart); err != nil {
		f.Close()
		return r.fail(CodeFailed)
	}
	r.samples = nil
	r.tick(true)
	buf := make([]byte, chunk)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			stall.Reset(s.stall)
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				return r.fail(r.diskCode(werr))
			}
			r.have += int64(n)
			r.tick(false)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return r.netError()
		}
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return r.fail(r.diskCode(err))
	}
	if err := f.Close(); err != nil {
		return r.fail(r.diskCode(err))
	}
	return r.finish()
}

// restartOrFail starts the file over, once; then the size is wrong.
func (r *runner) restartOrFail() result {
	if r.restart {
		return r.fail(CodeSizeMismatch)
	}
	r.restart = true
	r.truncate()
	return rRetry
}

// finish checks the size and moves the part file into place.
func (r *runner) finish() result {
	if r.d.Total > 0 && r.have != r.d.Total {
		return r.restartOrFail()
	}
	part := r.partFile()
	final := strings.TrimSuffix(part, ".part")
	if err := os.Rename(part, final); err != nil {
		return r.fail(r.diskCode(err))
	}
	file := strings.TrimSuffix(r.d.File, ".part")
	now := time.Now().UnixMilli()
	r.state, r.d.Reason = "done", ""
	r.d.File = file
	r.s.update(r.st, r.d.ID, func(d *store.Download) {
		d.State, d.Reason, d.File = "done", "", file
		d.Bytes, d.Total, d.DoneAt = r.have, r.have, now
	})
	r.s.emit(EventProgress, Progress{ID: r.d.ID, Bytes: r.have, Total: r.have})
	return rDone
}

// setFile names the part file from the first answer: the extension is the
// content type's, or the link's, and .mkv when neither says.
func (r *runner) setFile(resp *http.Response) {
	kind := mediaType(resp.Header.Get("Content-Type"))
	if kind == "" || kind == "application/octet-stream" {
		kind = r.src.ContentType
	}
	ext := extension(kind, resp.Request.URL, r.src.URL)
	file := r.d.ID + "/video" + ext + ".part"
	r.d.File = file
	r.d.MimeType = kind
	r.s.update(r.st, r.d.ID, func(d *store.Download) {
		d.File, d.MimeType, d.Total = file, kind, r.d.Total
	})
}

func userAgent(src streams.Source, version string) string {
	if src.UserAgent != "" {
		return src.UserAgent
	}
	return "Peli/" + version
}

func mediaType(header string) string {
	kind, _, err := mime.ParseMediaType(header)
	if err != nil {
		return ""
	}
	return kind
}

var videoTypes = map[string]string{
	"video/mp4": ".mp4", "video/x-matroska": ".mkv", "video/webm": ".webm",
	"video/quicktime": ".mov", "video/x-msvideo": ".avi", "video/mp2t": ".ts",
	"video/x-m4v": ".m4v", "video/mpeg": ".mpg", "video/x-ms-wmv": ".wmv",
}

var videoExts = []string{".mkv", ".mp4", ".m4v", ".webm", ".avi", ".mov", ".ts", ".mpg", ".mpeg", ".wmv"}

// extension is the file's extension: from the content type, else the path of
// one of the links, else .mkv.
func extension(kind string, final *url.URL, raw string) string {
	if ext, ok := videoTypes[kind]; ok {
		return ext
	}
	paths := []string{}
	if final != nil {
		paths = append(paths, final.Path)
	}
	if u, err := url.Parse(raw); err == nil {
		paths = append(paths, u.Path)
	}
	for _, p := range paths {
		ext := strings.ToLower(path.Ext(p))
		for _, known := range videoExts {
			if ext == known {
				return ext
			}
		}
	}
	return ".mkv"
}

// parseContentRange reads "bytes 100-199/1000": the first byte and the
// total, which is 0 for "*".
func parseContentRange(header string) (start, total int64, ok bool) {
	rest, found := strings.CutPrefix(strings.TrimSpace(header), "bytes ")
	if !found {
		return 0, 0, false
	}
	span, all, found := strings.Cut(rest, "/")
	if !found {
		return 0, 0, false
	}
	first, _, found := strings.Cut(span, "-")
	if !found {
		return 0, 0, false
	}
	start, err := strconv.ParseInt(strings.TrimSpace(first), 10, 64)
	if err != nil {
		return 0, 0, false
	}
	if all = strings.TrimSpace(all); all != "*" {
		if total, err = strconv.ParseInt(all, 10, 64); err != nil {
			return 0, 0, false
		}
	}
	return start, total, true
}

// extras saves what plays with the file: the addon's subtitles and the skip
// markers. They run before the video, so they are there once it's done.
// Failures are logged and skipped.
func (r *runner) extras() {
	for i, sub := range r.d.Subtitles {
		if sub.File != "" || r.ctx.Err() != nil {
			continue
		}
		file, err := r.saveSubtitle(i, sub.URL)
		if err != nil {
			slog.Info("downloads: subtitle skipped", "err", err)
			continue
		}
		r.d.Subtitles[i].File = file
		r.s.update(r.st, r.d.ID, func(d *store.Download) {
			if i < len(d.Subtitles) {
				d.Subtitles[i].File = file
			}
		})
	}
	if r.s.cfg.Markers == nil || len(r.d.Segments) > 0 || r.ctx.Err() != nil || !imdb.MatchString(r.d.ContentID) {
		return
	}
	ctx, cancel := context.WithTimeout(r.ctx, r.s.markerWait)
	defer cancel()
	segs, err := r.s.cfg.Markers(ctx, markers.Title{IMDbID: r.d.ContentID, Season: r.d.Season, Episode: r.d.Episode})
	if err != nil || len(segs) == 0 {
		return
	}
	saved := make([]store.DownloadSegment, 0, len(segs))
	for _, seg := range segs {
		saved = append(saved, store.DownloadSegment{Kind: seg.Kind, Start: seg.Start, End: seg.End})
	}
	r.d.Segments = saved
	r.s.update(r.st, r.d.ID, func(d *store.Download) { d.Segments = saved })
}

// saveSubtitle fetches a subtitle (5 MiB at most, 15 s) into subs/<n>.<ext>
// and returns its path relative to the root.
func (r *runner) saveSubtitle(n int, raw string) (string, error) {
	ctx, cancel := context.WithTimeout(r.ctx, r.s.subtitleTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return "", errors.New("bad subtitle link")
	}
	req.Header.Set("User-Agent", "Peli/"+r.s.cfg.Version)
	resp, err := r.s.httpc.Do(req)
	if err != nil {
		return "", errors.New("subtitle unreachable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", errors.New("subtitle answered " + strconv.Itoa(resp.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSubtitle+1))
	if err != nil {
		return "", errors.New("subtitle cut off")
	}
	if len(body) > maxSubtitle {
		return "", errors.New("subtitle too large")
	}
	rel := r.d.ID + "/subs/" + strconv.Itoa(n) + subtitleExt(raw)
	full := filepath.Join(r.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(full, body, 0o600); err != nil {
		return "", err
	}
	return rel, nil
}

// subtitleExt is the link's extension when it is a short plain one, else .srt.
func subtitleExt(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		ext := strings.ToLower(path.Ext(u.Path))
		if len(ext) >= 2 && len(ext) <= 6 && strings.Trim(ext[1:], "abcdefghijklmnopqrstuvwxyz0123456789") == "" {
			return ext
		}
	}
	return ".srt"
}
