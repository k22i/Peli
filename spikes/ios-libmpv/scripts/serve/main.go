// Serves a directory over HTTP with Range support (python's http.server has
// none), so seeks go through the network the way they do on a debrid link.
package main

import (
	"flag"
	"log"
	"net/http"
)

func main() {
	dir := flag.String("dir", "media", "directory to serve")
	addr := flag.String("addr", "127.0.0.1:8765", "listen address")
	flag.Parse()
	log.Printf("serving %s on http://%s", *dir, *addr)
	log.Fatal(http.ListenAndServe(*addr, http.FileServer(http.Dir(*dir))))
}
