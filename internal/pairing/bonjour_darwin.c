//go:build darwin && !ios

#include "bonjour_darwin.h"

#include <arpa/inet.h>
#include <string.h>
#include <sys/select.h>
#include <time.h>

#define SERVICE "_peli-pair._tcp"

DNSServiceRef peli_bonjour_register(uint16_t port, const char *tag) {
	TXTRecordRef txt;
	TXTRecordCreate(&txt, 0, NULL);
	TXTRecordSetValue(&txt, "v", 1, "1");
	TXTRecordSetValue(&txt, "t", (uint8_t)strlen(tag), tag);
	DNSServiceRef ref = NULL;
	// No callback: the advert stands until the ref is deallocated.
	DNSServiceErrorType err = DNSServiceRegister(&ref, 0, 0, NULL, SERVICE, NULL, NULL, htons(port),
		TXTRecordGetLength(&txt), TXTRecordGetBytesPtr(&txt), NULL, NULL);
	TXTRecordDeallocate(&txt);
	return err == kDNSServiceErr_NoError ? ref : NULL;
}

void peli_bonjour_stop(DNSServiceRef ref) {
	if (ref) DNSServiceRefDeallocate(ref);
}

typedef struct {
	char name[256], type[256], domain[256];
	uint32_t iface;
} peliFound;

typedef struct {
	peliFound items[16];
	int n;
} peliBrowse;

typedef struct {
	const char *tag;
	int state; // 0 waiting, 1 matched, -1 not this one
	char host[1025];
	uint16_t port;
} peliResolve;

static void browsed(DNSServiceRef ref, DNSServiceFlags flags, uint32_t iface, DNSServiceErrorType err,
	const char *name, const char *type, const char *domain, void *ctx) {
	peliBrowse *b = ctx;
	if (err != kDNSServiceErr_NoError || !(flags & kDNSServiceFlagsAdd) || b->n >= 16) return;
	peliFound *f = &b->items[b->n++];
	strlcpy(f->name, name, sizeof f->name);
	strlcpy(f->type, type, sizeof f->type);
	strlcpy(f->domain, domain, sizeof f->domain);
	f->iface = iface;
}

static void resolved(DNSServiceRef ref, DNSServiceFlags flags, uint32_t iface, DNSServiceErrorType err,
	const char *fullname, const char *host, uint16_t port, uint16_t txtLen, const unsigned char *txt, void *ctx) {
	peliResolve *r = ctx;
	r->state = -1;
	if (err != kDNSServiceErr_NoError) return;
	uint8_t len = 0;
	const void *v = TXTRecordGetValuePtr(txtLen, txt, "t", &len);
	if (v && len == strlen(r->tag) && memcmp(v, r->tag, len) == 0) {
		strlcpy(r->host, host, sizeof r->host);
		r->port = ntohs(port);
		r->state = 1;
	}
}

static long long nowMs(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

// pump waits up to ms for ref's socket and handles one reply.
static void pump(DNSServiceRef ref, long long ms) {
	if (ms <= 0) return;
	int fd = DNSServiceRefSockFD(ref);
	if (fd < 0) return;
	fd_set set;
	FD_ZERO(&set);
	FD_SET(fd, &set);
	struct timeval tv = {(time_t)(ms / 1000), (suseconds_t)((ms % 1000) * 1000)};
	if (select(fd + 1, &set, NULL, NULL, &tv) > 0) DNSServiceProcessResult(ref);
}

int peli_bonjour_find(const char *tag, int timeout_ms, char *host, int hostlen, uint16_t *port) {
	peliBrowse b;
	memset(&b, 0, sizeof b);
	DNSServiceRef browse = NULL;
	DNSServiceErrorType err = DNSServiceBrowse(&browse, 0, 0, SERVICE, NULL, browsed, &b);
	if (err != kDNSServiceErr_NoError) return err < 0 ? err : -1;
	long long deadline = nowMs() + timeout_ms;
	int next = 0;
	while (nowMs() < deadline) {
		long long left = deadline - nowMs();
		pump(browse, left < 250 ? left : 250);
		while (next < b.n) {
			peliFound *f = &b.items[next++];
			peliResolve r;
			memset(&r, 0, sizeof r);
			r.tag = tag;
			DNSServiceRef res = NULL;
			if (DNSServiceResolve(&res, 0, f->iface, f->name, f->type, f->domain, resolved, &r) != kDNSServiceErr_NoError) continue;
			long long until = nowMs() + 2000;
			while (r.state == 0 && nowMs() < until) pump(res, 250);
			DNSServiceRefDeallocate(res);
			if (r.state == 1) {
				strlcpy(host, r.host, (size_t)hostlen);
				*port = r.port;
				DNSServiceRefDeallocate(browse);
				return 0;
			}
		}
	}
	DNSServiceRefDeallocate(browse);
	return 1;
}
