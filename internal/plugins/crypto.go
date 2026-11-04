package plugins

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/des"
	"crypto/hmac"
	"crypto/md5"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha3"
	"crypto/sha512"
	"errors"
	"fmt"
	"hash"

	"github.com/dop251/goja"
)

// The crypto host behind crypto-js (cryptojs.js) and crypto.getRandomValues.
// Bytes cross as ArrayBuffers.

func hasher(name string) (func() hash.Hash, error) {
	switch name {
	case "MD5":
		return md5.New, nil
	case "SHA1":
		return sha1.New, nil
	case "SHA224":
		return sha256.New224, nil
	case "SHA256":
		return sha256.New, nil
	case "SHA384":
		return sha512.New384, nil
	case "SHA512":
		return sha512.New, nil
	case "SHA3":
		// crypto-js's SHA3 defaults to 512 bits: Keccak, as before
		// FIPS 202's padding. Ours is FIPS 202, as most sites' servers.
		return func() hash.Hash { return sha3.New512() }, nil
	}
	return nil, fmt.Errorf("unsupported hash %q", name)
}

func blockCipher(name string, key []byte) (cipher.Block, error) {
	switch name {
	case "AES":
		return aes.NewCipher(key)
	case "DES":
		return des.NewCipher(key)
	case "TripleDES":
		if len(key) == 16 {
			key = append(append([]byte{}, key...), key[:8]...)
		}
		return des.NewTripleDESCipher(key)
	}
	return nil, fmt.Errorf("unsupported cipher %q", name)
}

func pad(data []byte, size int, padding string) ([]byte, error) {
	n := size - len(data)%size
	switch padding {
	case "Pkcs7":
		for range n {
			data = append(data, byte(n))
		}
	case "AnsiX923":
		for range n - 1 {
			data = append(data, 0)
		}
		data = append(data, byte(n))
	case "Iso10126":
		random := make([]byte, n-1)
		_, _ = rand.Read(random)
		data = append(append(data, random...), byte(n))
	case "Iso97971":
		data = append(data, 0x80)
		for len(data)%size != 0 {
			data = append(data, 0)
		}
	case "ZeroPadding":
		for len(data)%size != 0 {
			data = append(data, 0)
		}
	case "NoPadding":
	default:
		return nil, fmt.Errorf("unsupported padding %q", padding)
	}
	return data, nil
}

// unpad is as lenient as crypto-js, which trusts the last byte: a wrong key
// gives garbage or nothing, not an error.
func unpad(data []byte, padding string) []byte {
	if len(data) == 0 {
		return data
	}
	switch padding {
	case "Pkcs7", "AnsiX923", "Iso10126":
		n := int(data[len(data)-1])
		if n > len(data) {
			return nil
		}
		return data[:len(data)-n]
	case "Iso97971":
		for i := len(data) - 1; i >= 0; i-- {
			if data[i] == 0x80 {
				return data[:i]
			}
		}
		return data
	case "ZeroPadding":
		i := len(data)
		for i > 0 && data[i-1] == 0 {
			i--
		}
		return data[:i]
	}
	return data
}

// crypt is one encryption or decryption, as crypto-js's modes do it. CFB
// is crypto-js's: whole blocks, like OFB and CTR.
func crypt(encrypt bool, name, mode, padding string, key, iv, data []byte) ([]byte, error) {
	block, err := blockCipher(name, key)
	if err != nil {
		return nil, err
	}
	size := block.BlockSize()
	if mode != "ECB" {
		if len(iv) == 0 {
			// crypto-js treats a missing IV as zeros.
			iv = make([]byte, size)
		}
		if len(iv) < size {
			return nil, errors.New("IV too short")
		}
		iv = iv[:size]
	}
	stream := mode == "CTR" || mode == "OFB" || mode == "CFB"
	if encrypt && !stream {
		if data, err = pad(append([]byte{}, data...), size, padding); err != nil {
			return nil, err
		}
	}
	if !stream && len(data)%size != 0 {
		return nil, errors.New("data isn't a whole number of blocks")
	}
	out := make([]byte, len(data))
	switch mode {
	case "CBC":
		if encrypt {
			cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, data)
		} else {
			cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, data)
		}
	case "ECB":
		for i := 0; i < len(data); i += size {
			if encrypt {
				block.Encrypt(out[i:i+size], data[i:i+size])
			} else {
				block.Decrypt(out[i:i+size], data[i:i+size])
			}
		}
	case "CTR":
		cipher.NewCTR(block, iv).XORKeyStream(out, data)
	case "OFB":
		cipher.NewOFB(block, iv).XORKeyStream(out, data) //nolint:staticcheck // crypto-js has it
	case "CFB":
		if encrypt {
			cipher.NewCFBEncrypter(block, iv).XORKeyStream(out, data) //nolint:staticcheck
		} else {
			cipher.NewCFBDecrypter(block, iv).XORKeyStream(out, data) //nolint:staticcheck
		}
	default:
		return nil, fmt.Errorf("unsupported mode %q", mode)
	}
	if !encrypt && !stream {
		out = unpad(out, padding)
	}
	return out, nil
}

// evpKDF is OpenSSL's EVP_BytesToKey, as crypto-js derives a key and IV
// from a passphrase.
func evpKDF(newHash func() hash.Hash, password, salt []byte, size, iterations int) []byte {
	var out, block []byte
	for len(out) < size {
		h := newHash()
		h.Write(block)
		h.Write(password)
		h.Write(salt)
		block = h.Sum(nil)
		for i := 1; i < iterations; i++ {
			h = newHash()
			h.Write(block)
			block = h.Sum(nil)
		}
		out = append(out, block...)
	}
	return out[:size]
}

// maxKDFWork caps a key derivation's iterations, so one call can't spin
// without the interrupt seeing it.
const maxKDFWork = 1_000_000

func (s *sandbox) installCrypto(host *goja.Object) {
	vm := s.vm
	buf := func(b []byte) goja.Value { return vm.ToValue(vm.NewArrayBuffer(b)) }
	host.Set("hash", func(name string, data goja.ArrayBuffer) (goja.Value, error) {
		h, err := hasher(name)
		if err != nil {
			return nil, err
		}
		sum := h()
		sum.Write(data.Bytes())
		return buf(sum.Sum(nil)), nil
	})
	host.Set("hmac", func(name string, key, data goja.ArrayBuffer) (goja.Value, error) {
		h, err := hasher(name)
		if err != nil {
			return nil, err
		}
		mac := hmac.New(h, key.Bytes())
		mac.Write(data.Bytes())
		return buf(mac.Sum(nil)), nil
	})
	host.Set("cipher", func(encrypt bool, name, mode, padding string, key, iv, data goja.ArrayBuffer) (goja.Value, error) {
		out, err := crypt(encrypt, name, mode, padding, key.Bytes(), iv.Bytes(), data.Bytes())
		if err != nil {
			return nil, err
		}
		return buf(out), nil
	})
	host.Set("pbkdf2", func(name string, password, salt goja.ArrayBuffer, iterations, size int) (goja.Value, error) {
		h, err := hasher(name)
		if err != nil {
			return nil, err
		}
		if iterations < 1 || iterations > maxKDFWork || size < 1 || size > 1024 {
			return nil, errors.New("PBKDF2 parameters out of range")
		}
		key, err := pbkdf2.Key(h, string(password.Bytes()), salt.Bytes(), iterations, size)
		if err != nil {
			return nil, err
		}
		return buf(key), nil
	})
	host.Set("evpKDF", func(name string, password, salt goja.ArrayBuffer, iterations, size int) (goja.Value, error) {
		h, err := hasher(name)
		if err != nil {
			return nil, err
		}
		if iterations < 1 || iterations > maxKDFWork || size < 1 || size > 1024 {
			return nil, errors.New("EvpKDF parameters out of range")
		}
		return buf(evpKDF(h, password.Bytes(), salt.Bytes(), size, iterations)), nil
	})
	host.Set("random", func(n int) (goja.Value, error) {
		if n < 0 || n > 65536 {
			return nil, errors.New("random: at most 65536 bytes")
		}
		b := make([]byte, n)
		_, _ = rand.Read(b)
		return buf(b), nil
	})
	host.Set("randomUUID", uuid)
}

func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
