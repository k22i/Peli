//go:build ios

package secrets

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <stdlib.h>
#include <string.h>

// Peli's own Keychain items (generic passwords). Wails' SecureSet files every
// value under kSecAttrAccessibleWhenUnlockedThisDeviceOnly and offers no
// other class, which would make the session unreadable when a push runs in
// the background with the phone locked (Phase 6). These use
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: readable from the first
// unlock after a boot, never in a backup, never on another device.

static CFMutableDictionaryRef peliQuery(const char *account) {
	CFMutableDictionaryRef q = CFDictionaryCreateMutable(NULL, 0,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFStringRef service = CFStringCreateWithCString(NULL, "k22i.net.peli.secrets", kCFStringEncodingUTF8);
	CFStringRef acct = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
	CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
	CFDictionarySetValue(q, kSecAttrService, service);
	CFDictionarySetValue(q, kSecAttrAccount, acct);
	CFRelease(service);
	CFRelease(acct);
	return q;
}

static OSStatus peliKeychainSet(const char *account, const char *value, int len) {
	CFMutableDictionaryRef q = peliQuery(account);
	CFDataRef data = CFDataCreate(NULL, (const UInt8 *)value, len);
	CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(NULL, 0,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFDictionarySetValue(attrs, kSecValueData, data);
	CFDictionarySetValue(attrs, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly);
	OSStatus status = SecItemUpdate(q, attrs);
	if (status == errSecItemNotFound) {
		CFDictionarySetValue(q, kSecValueData, data);
		CFDictionarySetValue(q, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly);
		status = SecItemAdd(q, NULL);
	}
	CFRelease(attrs);
	CFRelease(data);
	CFRelease(q);
	return status;
}

// peliKeychainGet returns errSecSuccess and a malloc'd copy of the value
// (free it), or another status.
static OSStatus peliKeychainGet(const char *account, char **out, int *outLen) {
	CFMutableDictionaryRef q = peliQuery(account);
	CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
	CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
	CFTypeRef result = NULL;
	OSStatus status = SecItemCopyMatching(q, &result);
	CFRelease(q);
	if (status != errSecSuccess) return status;
	CFDataRef data = (CFDataRef)result;
	*outLen = (int)CFDataGetLength(data);
	*out = malloc(*outLen + 1);
	memcpy(*out, CFDataGetBytePtr(data), *outLen);
	CFRelease(data);
	return errSecSuccess;
}

static OSStatus peliKeychainDelete(const char *account) {
	CFMutableDictionaryRef q = peliQuery(account);
	OSStatus status = SecItemDelete(q);
	CFRelease(q);
	return status;
}

static int peliNotFound(OSStatus s) { return s == errSecItemNotFound; }
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
)

func keychainError(op string, status C.OSStatus) error {
	return fmt.Errorf("keychain %s: OSStatus %d", op, int(status))
}

func keychainSet(account, value string) error {
	if account == "" {
		return errors.New("keychain: empty key")
	}
	a := C.CString(account)
	defer C.free(unsafe.Pointer(a))
	v := C.CString(value)
	defer C.free(unsafe.Pointer(v))
	if status := C.peliKeychainSet(a, v, C.int(len(value))); status != C.errSecSuccess {
		return keychainError("set", status)
	}
	return nil
}

func keychainGet(account string) (string, bool, error) {
	if account == "" {
		return "", false, errors.New("keychain: empty key")
	}
	a := C.CString(account)
	defer C.free(unsafe.Pointer(a))
	var out *C.char
	var n C.int
	status := C.peliKeychainGet(a, &out, &n)
	if C.peliNotFound(status) != 0 {
		return "", false, nil
	}
	if status != C.errSecSuccess {
		return "", false, keychainError("get", status)
	}
	defer C.free(unsafe.Pointer(out))
	return C.GoStringN(out, n), true, nil
}

func keychainDelete(account string) error {
	if account == "" {
		return errors.New("keychain: empty key")
	}
	a := C.CString(account)
	defer C.free(unsafe.Pointer(a))
	if status := C.peliKeychainDelete(a); status != C.errSecSuccess && C.peliNotFound(status) == 0 {
		return keychainError("delete", status)
	}
	return nil
}
