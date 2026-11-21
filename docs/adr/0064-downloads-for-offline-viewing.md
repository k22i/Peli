---
status: accepted
date: 2026-11-22
---

# Downloads for offline viewing: Go downloads the ranked or picked stream into a per-device folder, and a downloaded copy always plays before anything is resolved

#85 asks for a film or an episode to be downloaded and then watched with no network, on macOS and on iOS (iPhone and iPad). This ADR fixes the decisions and the interfaces the work is built against. "Built" notes are added when it's finished.

## Decisions

1. **Source.** The frontend chooses the stream: the ranking engine's top pick (it runs in the webview's worker and already respects the stream-preferences cap, ADR-0048, and the remembered source, ADR-0044), or a row the user picks in the stream picker. It hands Go the stream's addon link (`streams.Request`). Go does the rest.
   - **Debrid/HTTP:** Go resolves the link with `streams.Service.Resolve` (ADR-0037) when the job starts, then GETs the CDN link with `Range: bytes=<have>-` so a paused, failed or interrupted job resumes. When the CDN answers `expired` (401/403/404/410), Go resolves the same addon link once more and carries on. A second expiry in the same run fails the job with `expired`. Asking the addon for a new link is the frontend's job, so the user downloads it again from the title. Resolve's notice codes (`caching`, `denied`, `busy`, `failed`) fail the job with that code.
   - **No torrent downloads (user's call at the gate, 2026-11-22).** Only streams with a link (debrid, direct HTTP, plugin links) can be downloaded. A torrent-only stream (no `url`) shows no Download action, and "Download season" skips the torrent picks and takes the best linked stream instead. `internal/torrent` is untouched. Torrent downloads are a revisit trigger.
   - **Integrity:** debrid CDNs give no checksum. Go checks the size: the final length must equal `Content-Range`'s total (or the resolved `Source.size`). A mismatch restarts the job from zero once, then fails with `size_mismatch`.
   - **No debrid keys** (ADR-0038). Resolving goes through the addon, as for playing. As ADR-0060 notes, resolving adds the torrent to the user's debrid list. A download is an explicit choice to fetch the file, so no extra prompt.
2. **Storage.**
   - **Desktop:** `<app data>/Peli/Downloads` (the folder `peli.db` is in, so `PELI_DATA_DIR` moves it too). The folder can be changed in Settings › Downloads (`DeviceSettings.downloadsDir`, `""` = default). A change applies to new jobs. Existing downloads keep their own root, recorded per download.
   - **iOS:** `<Application Support>/Downloads`, excluded from iCloud/iTunes backup (`NSURLIsExcludedFromBackupKey` on the folder). The app container's path changes between installs and updates, so a download stores a root of `""` (the platform default, resolved at run time) and a file path relative to it, never an absolute path.
   - **Limits:** a device cap (`downloadsCapGB`, default 50, one of 10/25/50/100/250/500). Partial files count towards it. Before each job starts, and again once its size is known, Go checks free space: what's left to fetch plus a 1 GiB margin. Without that room, the job fails with `over_cap` or `no_space`. `ENOSPC` while writing fails the job with `no_space` and keeps the part file.
   - **Queue:** one running job at a time. The others are `queued` in creation order. The queue is the store's download records, so it survives a relaunch: on startup, `downloading` becomes `queued` and the queue restarts.
3. **Ownership and kids.** Downloads belong to the device: never synced to Nuvio, one bucket outside the profiles. Each one is shown only to the profile that started it (`profileId`), so two profiles downloading the same episode make two copies (sharing copies is a revisit trigger). A kids profile may add, list and play only downloads whose `metaAddon` (the addon that served the title's details) is in `Store.VisibleAddons(profile)`. It may pause, resume and delete its own downloads, but `DeleteAll` and `ChooseFolder` refuse with `kids_profile`. When a profile is gone, startup removes its downloads and their files.
4. **Playback.** A finished download always wins over resolving: `usePlay`, the stream picker's pick, the next episode and the card menu's Play ask `Downloads.Playable` first, and load its local file in `Player.Load`. Progress, watched marks and tracking go through the same `LoadOptions.watching` path as streaming (ADR-0039, #64), so they queue offline and push later as they do today. At job start Go saves addon subtitles in the profile's language and, for IMDb titles with skip times on, IntroDB skip markers next to the file. Offline, the player adds those subtitles from disk (`Player.AddSubtitle` takes `file://` URLs inside a downloads root) and uses the saved markers instead of asking IntroDB. The stream switcher lists the local copy as "Downloaded".
5. **iOS background.** **`beginBackgroundTask` only, no background `URLSession`.** A background session hands the transfer to `nsurlsessiond`, which writes the file outside Go and reports through delegate callbacks that can arrive after a relaunch. It can't take Go's re-resolve on `expired`, the addon's request headers, Go's Range/size checks, so it would be a second downloader. When the app goes to the background with a job running, Go asks for background time. Before it runs out (and on the expiration handler), Go flushes the part file and progress, and sets running jobs to `waiting` with reason `suspended`. Becoming active resumes them. **Wi-Fi only** is on by default (`downloadsWiFiOnly`): while the path is expensive (cellular or Personal Hotspot, `NWPath.isExpensive`), jobs wait with reason `wifi`. With no path they wait with `offline`, on every platform. On the desktop, `offline` is detected from network errors, retried with backoff (15 s doubling to 5 min).

## Store (internal/store, part 1)

New top-level bucket, migration 8 (`CreateBucketIfNotExists`), keyed by download id:

```
downloads          <id> → Download   (device-level; not under profiles, never synced)
```

```go
// downloads.go
type Download struct {
	ID        string `json:"id"`        // 32 hex chars, random
	ProfileID uint64 `json:"profileId"`
	// What it is, enough to play it and report progress offline.
	ContentID   string `json:"contentId"`   // "tt0903747", "kitsu:123"
	ContentType string `json:"contentType"` // "movie" | "series" (the addon type)
	VideoID     string `json:"videoId"`     // the episode's video id, or ContentID for a film
	Season      int    `json:"season"`      // 0 for a film
	Episode     int    `json:"episode"`     // 0 for a film
	Name        string `json:"name"`        // the title's name
	EpisodeName string `json:"episodeName"` // "" for a film
	Poster      string `json:"poster"`      // URL, shown while online; may be ""
	MetaAddon   string `json:"metaAddon"`   // addon URL that served the details (kids rule)
	// Which stream, as the picker labels it.
	StreamSource      string `json:"streamSource"` // addon URL or "plugin:<id>"
	StreamName        string `json:"streamName"`
	StreamDescription string `json:"streamDescription"`
	Resolution        string `json:"resolution"` // "1080p", "" unknown
	Request DownloadRequest `json:"request"` // the addon link Resolve takes
	// Where: Root "" is the platform default; File is relative to the root
	// ("<id>/video.mkv"); while running it is File + ".part".
	Root     string `json:"root"`
	File     string `json:"file"`
	MimeType string `json:"mimeType"`
	Subtitles []DownloadSubtitle `json:"subtitles"`
	Segments  []DownloadSegment  `json:"segments"`
	// State: DownloadStates. Reason says why it waits or failed.
	State  string `json:"state"`
	Reason string `json:"reason"`
	Bytes  int64  `json:"bytes"` // on disk
	Total  int64  `json:"total"` // 0 until known
	CreatedAt int64 `json:"createdAt"` // unix ms; queue order
	UpdatedAt int64 `json:"updatedAt"`
	DoneAt    int64 `json:"doneAt"` // 0 until done
}
type DownloadRequest struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}
type DownloadSubtitle struct {
	URL   string `json:"url"`   // the addon's
	Lang  string `json:"lang"`
	Title string `json:"title"`
	File  string `json:"file"`  // relative to Root; "" until saved
}
type DownloadSegment struct {
	Kind  string  `json:"kind"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

var DownloadStates = []string{"queued", "downloading", "paused", "waiting", "failed", "done"}

func (s *Store) Downloads() ([]Download, error)                         // all, by CreatedAt
func (s *Store) ProfileDownloads(profileID uint64) ([]Download, error)  // one profile's, by CreatedAt
func (s *Store) Download(id string) (*Download, error)                  // nil, nil when missing
func (s *Store) PutDownload(d Download) error                           // insert or replace; validates
func (s *Store) UpdateDownload(id string, fn func(*Download) error) error // read-modify-write; ErrDownloadNotFound
func (s *Store) SetDownloadProgress(id string, bytes, total int64) error // cheap progress write
func (s *Store) DeleteDownload(id string) error                         // no error when missing
func (s *Store) DownloadedBytes() (int64, error)                        // sum of Bytes, every state
var ErrDownloadNotFound = errors.New("store: download not found")
```

`PutDownload` refuses (ErrInvalidItem) a record with no ID, profile, video id or `request.url`, or a state outside `DownloadStates`. `nil` slices decode as empty.

**DeviceSettings** gains (defaults in `DefaultDeviceSettings`, so older records get them):

```go
DownloadsDir      string `json:"downloadsDir"`      // "" = default; else an absolute path
DownloadsCapGB    int    `json:"downloadsCapGB"`    // one of DownloadCaps, default 50
DownloadsWiFiOnly bool   `json:"downloadsWiFiOnly"` // default true; only iOS reads it
var DownloadCaps = []int{10, 25, 50, 100, 250, 500}
```

Validation: `DownloadsDir` is `""` or absolute, and `DownloadsCapGB` is in `DownloadCaps`.

## Engine and Wails service (internal/downloads, parts 2 and 3)

`internal/downloads` is in both builds. It must not import `internal/torrent`, plugins, updates or firstmouse (ios_boundary_test.go). Goroutines go through `safego`.

```go
type Config struct {
	Open    func() *store.Store
	Resolve func(ctx context.Context, req streams.Request) (streams.Source, error) // streams.Service.Resolve
	Markers func(ctx context.Context, t markers.Title) ([]markers.Segment, error)  // markers.Service.Segments; nil = none
	Root    string // default root: filepath.Join(filepath.Dir(dbPath), "Downloads")
	Version string // User-Agent, as streams sends
}
func NewService(cfg Config) *Service
func MarshalError(err error) []byte      // {"code": …, "message": …}, like streams


// Platform is what differs per OS. platform_desktop.go (!ios, part 2) and
// platform_ios.go (+ .m, part 3) each define newPlatform() Platform.
type Platform interface {
	FreeSpace(dir string) (int64, error)  // bytes available to this app
	Prepare(root string) error            // mkdir; iOS also excludes it from backup
	Network() Network
	WatchNetwork(fn func(Network))        // called on every change
	// Background asks for time to keep running in the background; end is
	// called once the jobs stop; expiring is called (once) shortly before the
	// OS takes the time back. Desktop: no-op.
	Background(expiring func()) (end func())
	// WatchLifecycle reports going to the background and becoming active
	// (iOS: UIKit notifications; desktop: never).
	WatchLifecycle(background, active func())
	ChooseFolder() (string, error)        // desktop: folder dialog, "" when cancelled; iOS: ErrUnsupported
}
type Network struct {
	Online    bool `json:"online"`
	Expensive bool `json:"expensive"` // cellular or hotspot
}
```

**Bound methods** (`Service`), what the frontend calls:

```go
Add(req AddRequest) (store.Download, error)  // idempotent per (profile, videoId): returns the existing one unless it failed
List(profileID uint64) ([]store.Download, error) // the profile's, kids-filtered, by CreatedAt
Get(profileID uint64, id string) (*store.Download, error)
Pause(profileID uint64, id string) error
Resume(profileID uint64, id string) error   // paused, waiting or failed → queued
Delete(profileID uint64, ids []string) error // stops if running, removes files + records (also "cancel")
DeleteAll(profileID uint64) error            // every download on the device; kids_profile for a kids profile
Playable(profileID uint64, videoID string) (*Playable, error) // nil, nil unless a done download exists
Usage() (Usage, error)
ChooseFolder(profileID uint64) (string, error) // desktop; saves DeviceSettings.downloadsDir; "" = cancelled
Network() Network

type AddRequest struct {
	ProfileID   uint64 `json:"profileId"`
	ContentID   string `json:"contentId"`
	ContentType string `json:"contentType"`
	VideoID     string `json:"videoId"`
	Season      int    `json:"season"`
	Episode     int    `json:"episode"`
	Name        string `json:"name"`
	EpisodeName string `json:"episodeName"`
	Poster      string `json:"poster"`
	MetaAddon   string `json:"metaAddon"`
	StreamSource      string `json:"streamSource"`
	StreamName        string `json:"streamName"`
	StreamDescription string `json:"streamDescription"`
	Resolution        string `json:"resolution"`
	Request   streams.Request  `json:"request"` // the stream's url + behaviorHints headers
	Subtitles []SubtitleRef    `json:"subtitles"` // the frontend picks them (profile language)
}
type SubtitleRef struct {
	URL   string `json:"url"`
	Lang  string `json:"lang"`
	Title string `json:"title"`
}
type Playable struct {
	Download  store.Download    `json:"download"`
	Source    streams.Source    `json:"source"`    // URL = absolute file path, Origin = "download:<id>", ContentType, Size
	Subtitles []LocalSubtitle   `json:"subtitles"`
	Segments  []markers.Segment `json:"segments"`
}
type LocalSubtitle struct {
	URL   string `json:"url"` // file:// URL of the saved file
	Lang  string `json:"lang"`
	Title string `json:"title"`
}
type Usage struct {
	Used int64  `json:"used"` // DownloadedBytes
	Cap  int64  `json:"cap"`  // downloadsCapGB in bytes
	Free int64  `json:"free"` // FreeSpace of the active root
	Dir  string `json:"dir"`  // the active root, absolute
}
```

**Error codes** (MarshalError `code`, and a failed download's `reason`): `invalid`, `not_found`, `kids_profile`, `not_allowed` (a kids profile and a title outside its allow-list), `over_cap`, `no_space`, `expired`, `size_mismatch`, `not_video`, `caching`, `denied`, `busy`, `failed`, `unreachable`, `timeout`, `unsupported` (ChooseFolder on iOS). Wait reasons: `wifi`, `offline`, `suspended`.

**Events** (registered with `application.RegisterEvent`):

| Event | Payload | When |
|---|---|---|
| `downloads:changed` | `store.Download` | added, any state/reason change, done, subtitles/segments saved |
| `downloads:progress` | `Progress{id, bytes, total, rate}` (rate in bytes/s) | at most every 500 ms per running job |
| `downloads:removed` | `Removed{ids []string}` | deleted (Delete, DeleteAll, startup sweep) |

Progress is written to the store at most every 2 s, and on pause, background and stop. Files are laid out as `<root>/<id>/video<ext>[.part]`, `<root>/<id>/subs/<n>.<ext>`. The extension comes from the resolved content type or the file name. The startup sweep removes only `<root>/<id>` folders whose name is a 32-hex download id with no record, never anything else in a user-chosen folder.

**Wiring (part 2):** `main.go`'s `newPeli` hoists the streams service to `p.streams` and builds `p.downloads` (Root = `filepath.Join(filepath.Dir(dbPath), "Downloads")`, Resolve = `p.streams.Resolve`, Markers = `p.skipTimes.Segments`). It is registered with `MarshalError` right after `add(x.torrent)` in `services`, so it shuts down (checkpointing) before streams and the store. `main_desktop.go` and `main_ios.go` need no change: `platform_ios.go` watches the lifecycle itself.

## Frontend (parts 4 to 9)

`@bindings/downloads` is generated from `internal/downloads` (`Service` with the methods above; models `AddRequest`, `Playable`, `Usage`, `Progress`, `Removed`, `SubtitleRef`, `LocalSubtitle`, `Network`). `Download` comes from `@bindings/store`.

`lib/downloads.ts` (part 4):

- Query keys: `["downloads", profileId]` (List), `["downloads", "usage"]`, `["downloads", "network"]`. Events update the list cache: `changed` upserts, `progress` patches bytes/total plus a `rate` kept in a side map, `removed` drops.
- Hooks and helpers: `useDownloads(profileId)`, `useDownload(profileId, videoId)` (the one for a video, or undefined), `useDownloadUsage()`, `downloadsQuery(profileId)`, `downloadFor(list, videoId)`, `useDownloadActions(profileId)` (`add`, `pause`, `resume`, `remove(ids)`, `removeAll`, with toasts on refusal), `statusOf(download)` → `"queued" | "downloading" | "paused" | "waiting" | "failed" | "done"` plus label text, `percent(download)`, `reasonText(reason)`, `formatBytes` (re-exported from `lib/torrent.ts`), `addRequestFor(target, candidate, subtitles)` (builds an `AddRequest` from a play target and a ranked candidate), `playableQuery(profileId, videoId)`.
- A test mock of `@bindings/downloads` in `test/setup.ts`, defined inside the `vi.mock` factory (no app imports at the top of setup.ts).

Entry points (part 6) rank episodes in the frontend: "Download season" queues each aired episode in order, ranking its streams (the same engine `usePreparedNext` uses) and calling `Add`. Streams with no link (torrents) are never downloaded. The Downloads view is Library `?view=downloads` (part 7). Settings › Downloads is a new pane (part 8): location (desktop only, `feature("downloadFolder")` false on iOS), cap, Wi-Fi only (iOS only, `feature("downloadsWiFiOnly")`), and Delete all behind an alert dialog. Home gets a "Downloaded" row, and Play offline on a card with no download shows a toast (part 9).

## Consequences

- The App Store build gains no new background mode, since `beginBackgroundTask` needs none. A job that outlives the background time waits until the app comes back. That's the cost of one downloader.
- Two profiles can hold two copies of one file.
- A download made through an addon link that later dies can't be refreshed by Go. The user downloads it again.

## Revisit when

- Users want downloads to finish with the app suspended for hours: a background `URLSession` for debrid-only jobs, with Go handing it the resolved CDN link and its headers.
- A household wants one copy shared between profiles.
- Users ask for torrent downloads: through `internal/torrent`'s loopback server into a permanent file, yielding to the player's one torrent session.
- Peli gets debrid keys (ADR-0038 triggers), which would allow re-resolving without the addon.
