package plugins

import "testing"

func TestCryptoJS(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"hashes", `return [C.MD5("abc").toString(), C.SHA256("abc").toString(C.enc.Hex), String(C.SHA1(""))];`,
			`["900150983cd24fb0d6963f7d28e17f72","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","da39a3ee5e6b4b0d3255bfef95601890afd80709"]`},
		// RFC 4231, test case 2.
		{"hmac", `return C.HmacSHA256("what do ya want for nothing?", "Jefe").toString();`, `"5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"`},
		{"incremental", `const h = C.algo.SHA256.create(); h.update("a"); h.update("bc"); return h.finalize().toString();`,
			`"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"`},
		{"encoders", `const w = C.enc.Utf8.parse("héllo"); return [w.sigBytes, w.toString(C.enc.Base64), C.enc.Base64.parse("aMOpbGxv").toString(C.enc.Utf8),
			C.enc.Hex.parse("6869").toString(C.enc.Latin1), C.enc.Base64url.stringify(C.enc.Hex.parse("fbff")), C.enc.Utf16LE.parse("A").toString()];`,
			`[6,"aMOpbGxv","héllo","hi","-_8","4100"]`},
		{"word array", `const w = C.lib.WordArray.create([0x01020304, 0x05060708], 6); const c = w.clone().concat(C.enc.Hex.parse("ff"));
			return [w.toString(), c.toString(), c.sigBytes, C.lib.WordArray.random(16).sigBytes, C.lib.WordArray.create(new Uint8Array([1, 2])).toString()];`,
			`["010203040506","010203040506ff",7,16,"0102"]`},
		// openssl enc -aes-256-cbc -md md5 -S 0102030405060708 -pass pass:'Secret Passphrase' -base64
		{"passphrase decrypt (OpenSSL)", `return C.AES.decrypt("U2FsdGVkX18BAgMEBQYHCI27gYdl6BWNsdK0m0J1NgPjEfki/vMEnSBZ5xThrlG3", "Secret Passphrase").toString(C.enc.Utf8);`,
			`"https://cdn.example.com/v.m3u8"`},
		{"passphrase round trip", `const s = C.AES.encrypt("secret text", "pw").toString(); return [s.slice(0, 10), C.AES.decrypt(s, "pw").toString(C.enc.Utf8)];`,
			`["U2FsdGVkX1","secret text"]`},
		{"key and iv, CipherParams", `const key = C.enc.Hex.parse("000102030405060708090a0b0c0d0e0f"), iv = C.enc.Hex.parse("0f0e0d0c0b0a09080706050403020100");
			const ct = C.AES.encrypt("plain", key, { iv, mode: C.mode.CBC, padding: C.pad.Pkcs7 }).ciphertext;
			const params = C.lib.CipherParams.create({ ciphertext: C.enc.Base64.parse(ct.toString(C.enc.Base64)) });
			return [ct.sigBytes, C.AES.decrypt(params, key, { iv }).toString(C.enc.Utf8), C.AES.decrypt(ct.toString(C.enc.Base64), key, { iv }).toString(C.enc.Utf8)];`,
			`[16,"plain","plain"]`},
		{"ecb nopadding", `const key = C.enc.Utf8.parse("0123456789abcdef");
			const ct = C.AES.encrypt(C.enc.Utf8.parse("exactly16bytes!!"), key, { mode: C.mode.ECB, padding: C.pad.NoPadding });
			return [ct.ciphertext.sigBytes, C.AES.decrypt(ct, key, { mode: C.mode.ECB, padding: C.pad.NoPadding }).toString(C.enc.Utf8)];`,
			`[16,"exactly16bytes!!"]`},
		{"ctr", `const key = C.enc.Utf8.parse("0123456789abcdef"), iv = C.enc.Utf8.parse("abcdef9876543210");
			const ct = C.AES.encrypt("odd length", key, { iv, mode: C.mode.CTR, padding: C.pad.NoPadding });
			return [ct.ciphertext.sigBytes, C.AES.decrypt(ct, key, { iv, mode: C.mode.CTR, padding: C.pad.NoPadding }).toString(C.enc.Utf8)];`,
			`[10,"odd length"]`},
		// As crypto-js: garbage, nothing, or "Malformed UTF-8 data"; never
		// an error from the cipher.
		{"wrong key", `let out; try { out = C.AES.decrypt("U2FsdGVkX18BAgMEBQYHCI27gYdl6BWNsdK0m0J1NgPjEfki/vMEnSBZ5xThrlG3", "wrong").toString(C.enc.Utf8); }
			catch (e) { out = e.message; } return out !== "https://cdn.example.com/v.m3u8" && (out === "Malformed UTF-8 data" || typeof out === "string");`,
			`true`},
		{"bad utf-8 throws", `try { C.enc.Hex.parse("ff").toString(C.enc.Utf8); return "decoded"; } catch (e) { return e.message; }`, `"Malformed UTF-8 data"`},
		{"tripledes round trip", `const key = C.enc.Utf8.parse("0123456789abcdef01234567"), iv = C.enc.Utf8.parse("12345678");
			return C.TripleDES.decrypt(C.TripleDES.encrypt("des", key, { iv }), key, { iv }).toString(C.enc.Utf8);`, `"des"`},
		// RFC 6070, test case 2 (SHA-1, 2 iterations, 20 bytes).
		{"pbkdf2", `return C.PBKDF2("password", "salt", { keySize: 5, iterations: 2, hasher: C.algo.SHA1 }).toString();`,
			`"ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957"`},
		{"evpkdf", `return C.EvpKDF("pw", C.enc.Hex.parse("0102030405060708"), { keySize: 4 }).sigBytes;`, `16`},
		{"esm interop", `return typeof C.default.AES.decrypt;`, `"function"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := evalJS(t, `const C = require("crypto-js");`+tc.body); got != tc.want {
				t.Errorf("got  %s\nwant %s", got, tc.want)
			}
		})
	}
}
