//go:build production && cgo && !nosqlite

package main

// Release builds leave out anacrolix/torrent's SQLite piece-completion store
// (#55, ADR-0040): Sinag keeps piece state in its own cache, and the module
// the store needs, github.com/go-llsqlite/adapter, carries no licence. So a
// production build without -tags nosqlite stops here rather than shipping
// it. The Taskfiles and tools/notices pass the tag.
var _ = releaseBuildsNeedTheNosqliteTag
