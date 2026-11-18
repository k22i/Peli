//go:build darwin && !ios

// Bonjour for the phrase path (bonjour_darwin.c, #133): a Mac showing a
// phrase advertises _peli-pair._tcp with the phrase's first word as a tag;
// a Mac typing it finds that advert.
#ifndef PELI_BONJOUR_DARWIN_H
#define PELI_BONJOUR_DARWIN_H

#include <dns_sd.h>
#include <stdint.h>

// peli_bonjour_register advertises port with TXT t=tag, or returns NULL.
DNSServiceRef peli_bonjour_register(uint16_t port, const char *tag);
void peli_bonjour_stop(DNSServiceRef ref);
// peli_bonjour_find browses for up to timeout_ms for the advert with tag:
// 0 found (host and port filled in), 1 not found, < 0 a DNS-SD error.
int peli_bonjour_find(const char *tag, int timeout_ms, char *host, int hostlen, uint16_t *port);

#endif
