//go:build darwin && !ios

package secrets

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <stdlib.h>
#include <string.h>
#include <Security/Security.h>

static CFStringRef peli_str(const char *s) {
	return CFStringCreateWithCString(NULL, s, kCFStringEncodingUTF8);
}

// A query for one generic password, or every one of a service when acct is
// NULL. It never shows UI: an item Peli may not read fails with
// errSecInteractionNotAllowed instead of asking "Allow access?".
// (kSecUseAuthenticationUIFail is deprecated for an LAContext, which needs
// Objective-C; it still works.)
static CFMutableDictionaryRef peli_query(const char *svc, const char *acct) {
	CFMutableDictionaryRef q = CFDictionaryCreateMutable(NULL, 0,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
	CFStringRef s = peli_str(svc);
	CFDictionarySetValue(q, kSecAttrService, s);
	CFRelease(s);
	if (acct) {
		CFStringRef a = peli_str(acct);
		CFDictionarySetValue(q, kSecAttrAccount, a);
		CFRelease(a);
	}
	CFDictionarySetValue(q, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
	return q;
}

static OSStatus peli_get(const char *svc, const char *acct, void **data, long *len) {
	CFMutableDictionaryRef q = peli_query(svc, acct);
	CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
	CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
	CFTypeRef out = NULL;
	OSStatus st = SecItemCopyMatching(q, &out);
	CFRelease(q);
	if (st == errSecSuccess) {
		CFDataRef d = (CFDataRef)out;
		*len = CFDataGetLength(d);
		*data = malloc(*len > 0 ? *len : 1);
		memcpy(*data, CFDataGetBytePtr(d), *len);
		CFRelease(out);
	}
	return st;
}

// Adds an item. Its access list trusts the calling app's designated
// requirement: for a Developer ID build, its bundle ID and Team ID, which
// stay the same across updates.
static OSStatus peli_add(const char *svc, const char *acct, const void *val, long len) {
	CFMutableDictionaryRef q = peli_query(svc, acct);
	CFStringRef label = peli_str(svc); // what the security tool sets
	CFDictionarySetValue(q, kSecAttrLabel, label);
	CFRelease(label);
	CFDataRef v = CFDataCreate(NULL, val, len);
	CFDictionarySetValue(q, kSecValueData, v);
	CFRelease(v);
	OSStatus st = SecItemAdd(q, NULL);
	CFRelease(q);
	return st;
}

static OSStatus peli_delete(const char *svc, const char *acct) {
	CFMutableDictionaryRef q = peli_query(svc, acct);
	OSStatus st = SecItemDelete(q);
	CFRelease(q);
	return st;
}

// The service's account names, one per line (malloc'd), without reading
// any value.
static OSStatus peli_accounts(const char *svc, char **out) {
	CFMutableDictionaryRef q = peli_query(svc, NULL);
	CFDictionarySetValue(q, kSecReturnAttributes, kCFBooleanTrue);
	CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitAll);
	CFTypeRef res = NULL;
	OSStatus st = SecItemCopyMatching(q, &res);
	CFRelease(q);
	*out = NULL;
	if (st != errSecSuccess) return st;
	CFArrayRef items = (CFArrayRef)res;
	CFIndex n = CFArrayGetCount(items);
	size_t cap = 1, used = 0;
	char *buf = malloc(cap);
	buf[0] = 0;
	for (CFIndex i = 0; i < n; i++) {
		CFDictionaryRef item = CFArrayGetValueAtIndex(items, i);
		CFStringRef acct = CFDictionaryGetValue(item, kSecAttrAccount);
		if (!acct) continue;
		CFIndex max = CFStringGetMaximumSizeForEncoding(CFStringGetLength(acct), kCFStringEncodingUTF8) + 2;
		buf = realloc(buf, cap += max);
		if (!CFStringGetCString(acct, buf + used, max, kCFStringEncodingUTF8)) continue;
		used += strlen(buf + used);
		buf[used++] = '\n';
		buf[used] = 0;
	}
	CFRelease(res);
	*out = buf;
	return st;
}

static char *peli_message(OSStatus st) {
	CFStringRef m = SecCopyErrorMessageString(st, NULL);
	if (!m) return NULL;
	char *buf = malloc(256);
	if (!CFStringGetCString(m, buf, 256, kCFStringEncodingUTF8)) buf[0] = 0;
	CFRelease(m);
	return buf;
}

// Whether this process is signed with a certificate that has a Team ID
// (Developer ID), rather than ad hoc or not at all.
static int peli_team_signed(void) {
	SecCodeRef self = NULL;
	if (SecCodeCopySelf(kSecCSDefaultFlags, &self) != errSecSuccess) return 0;
	SecStaticCodeRef code = NULL;
	CFDictionaryRef info = NULL;
	int team = 0;
	if (SecCodeCopyStaticCode(self, kSecCSDefaultFlags, &code) == errSecSuccess &&
	    SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) == errSecSuccess) {
		team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier) != NULL;
		CFRelease(info);
	}
	if (code) CFRelease(code);
	CFRelease(self);
	return team;
}
*/
import "C"

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unsafe"

	"github.com/zalando/go-keyring"
)

// osBackend picks the macOS keychain path (#78, ADR-0053). A Developer ID
// build talks to Security.framework itself, so its items trust Peli's
// signature instead of /usr/bin/security. Anything else (go run, tests, a
// local ad-hoc package) keeps going through the security tool: an ad-hoc
// signature changes with every build, and items that trusted it would ask
// "Allow access?" after each one.
func osBackend() backend {
	if C.peli_team_signed() == 1 {
		return native{}
	}
	return tool{}
}

// The Security framework's statuses that native handles.
const (
	errSecItemNotFound          = -25300
	errSecDuplicateItem         = -25299
	errSecAuthFailed            = -25293
	errSecInteractionNotAllowed = -25308
	errSecInvalidOwnerEdit      = -25244
)

// migrated is the account of a marker item, saved once a service's items all
// trust Peli. It can't be a key (keys have no underscores), so the frontend
// never sees it.
const migrated = "_native"

// native keeps items with Security.framework. Items still filed by the
// security tool (from builds before #78, or a development build since) are
// readable, but only the tool may delete them; native goes through the tool
// for those, and rewrites them as its own.
type native struct{}

// The value is stored the way go-keyring stores it, so a development build
// on the same Mac can still read what a release wrote (after asking once:
// the item doesn't trust the security tool any more).
const (
	base64Prefix = "go-keyring-base64:"
	hexPrefix    = "go-keyring-encoded:"
)

func encode(value string) []byte {
	return []byte(base64Prefix + base64.StdEncoding.EncodeToString([]byte(value)))
}

func decode(data []byte) (string, error) {
	s := string(data)
	switch {
	case strings.HasPrefix(s, base64Prefix):
		b, err := base64.StdEncoding.DecodeString(s[len(base64Prefix):])
		return string(b), err
	case strings.HasPrefix(s, hexPrefix):
		b, err := hex.DecodeString(s[len(hexPrefix):])
		return string(b), err
	}
	return s, nil
}

type secError C.OSStatus

func (e secError) Error() string {
	msg := C.peli_message(C.OSStatus(e))
	if msg == nil {
		return fmt.Sprintf("keychain error %d", int(e))
	}
	defer C.free(unsafe.Pointer(msg))
	return fmt.Sprintf("keychain error %d: %s", int(e), C.GoString(msg))
}

func status(st C.OSStatus) error {
	switch st {
	case 0:
		return nil
	case errSecItemNotFound:
		return keyring.ErrNotFound
	}
	return secError(st)
}

// refused is an item Peli isn't on the access list of: the security tool's,
// or one another app filed under the same service.
func refused(err error) bool {
	var e secError
	return errors.As(err, &e) && (e == errSecInteractionNotAllowed || e == errSecAuthFailed || e == errSecInvalidOwnerEdit)
}

func cstrings(service, key string) (*C.char, *C.char, func()) {
	s, k := C.CString(service), C.CString(key)
	return s, k, func() { C.free(unsafe.Pointer(s)); C.free(unsafe.Pointer(k)) }
}

func (native) get(service, key string) (string, error) {
	s, k, free := cstrings(service, key)
	defer free()
	var data unsafe.Pointer
	var n C.long
	err := status(C.peli_get(s, k, &data, &n))
	if refused(err) {
		return tool{}.get(service, key)
	}
	if err != nil {
		return "", err
	}
	defer C.free(data)
	return decode(C.GoBytes(data, C.int(n)))
}

// set replaces the item rather than updating it, so the one it leaves is
// always Peli's own: an update would keep the old item's access list.
func (n native) set(service, key, value string) error {
	if err := n.delete(service, key); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return err
	}
	s, k, free := cstrings(service, key)
	defer free()
	data := encode(value)
	return status(C.peli_add(s, k, unsafe.Pointer(&data[0]), C.long(len(data))))
}

func (native) delete(service, key string) error {
	s, k, free := cstrings(service, key)
	defer free()
	err := status(C.peli_delete(s, k))
	if refused(err) {
		return tool{}.delete(service, key)
	}
	return err
}

// migrate rewrites every item of service as Peli's own, once: the first
// time a Developer ID build runs, the session and keys the earlier builds
// filed through the security tool move over. Until it has finished, get and
// delete still reach those items through the tool, so a failure here only
// means the next launch tries again.
func (n native) migrate(service string) error {
	if _, err := n.get(service, migrated); err == nil {
		return nil
	}
	s := C.CString(service)
	defer C.free(unsafe.Pointer(s))
	var list *C.char
	err := status(C.peli_accounts(s, &list))
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return fmt.Errorf("list %s: %w", service, err)
	}
	if list != nil {
		defer C.free(unsafe.Pointer(list))
		for _, key := range strings.Fields(C.GoString(list)) {
			value, err := n.get(service, key)
			if err != nil {
				return fmt.Errorf("read %q: %w", key, err)
			}
			if err := n.set(service, key, value); err != nil {
				return fmt.Errorf("rewrite %q: %w", key, err)
			}
		}
	}
	return n.set(service, migrated, "1")
}
