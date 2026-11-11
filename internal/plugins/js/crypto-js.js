// crypto-js, as plugins use it (#56): WordArrays and encoders (Hex, Base64,
// Utf8, Latin1, Utf16), hashes, HMAC, PBKDF2 and EvpKDF, and AES, DES and
// TripleDES with crypto-js's modes, paddings and OpenSSL "Salted__" format.
// Written for Peli to match crypto-js's behaviour; the work is Go's
// (crypto.go), with bytes crossing as ArrayBuffers.
(function (host) {
  "use strict";

  // A WordArray is crypto-js's bytes: big-endian 32-bit words and a length.
  function WordArray(words, sigBytes) {
    this.words = words || [];
    this.sigBytes = sigBytes !== undefined ? sigBytes : this.words.length * 4;
  }
  WordArray.prototype.toString = function (encoder) {
    return (encoder || Hex).stringify(this);
  };
  WordArray.prototype.concat = function (other) {
    var a = bytesOf(this);
    var b = bytesOf(other);
    var c = new Uint8Array(a.length + b.length);
    c.set(a);
    c.set(b, a.length);
    var joined = fromBytes(c);
    this.words = joined.words;
    this.sigBytes = joined.sigBytes;
    return this;
  };
  WordArray.prototype.clamp = function () {
    var clamped = fromBytes(bytesOf(this));
    this.words = clamped.words;
    return this;
  };
  WordArray.prototype.clone = function () {
    return new WordArray(this.words.slice(0), this.sigBytes);
  };
  WordArray.create = function (words, sigBytes) {
    if (words instanceof ArrayBuffer) return fromBytes(new Uint8Array(words));
    if (ArrayBuffer.isView(words)) return fromBytes(new Uint8Array(words.buffer, words.byteOffset, words.byteLength));
    return new WordArray(words, sigBytes);
  };
  WordArray.random = function (n) {
    return fromBytes(new Uint8Array(host.random(n)));
  };

  function bytesOf(wa) {
    var n = Math.max(0, wa.sigBytes | 0);
    var out = new Uint8Array(n);
    var words = wa.words;
    for (var i = 0; i < n; i++) out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    return out;
  }
  function fromBytes(bytes) {
    var words = [];
    for (var i = 0; i < bytes.length; i++) words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8);
    return new WordArray(words, bytes.length);
  }
  function buf(wa) {
    return bytesOf(wa).buffer;
  }
  function fromBuf(ab) {
    return fromBytes(new Uint8Array(ab));
  }
  function words(wa, start, count) {
    var bytes = bytesOf(wa).subarray(start * 4, (start + count) * 4);
    return fromBytes(bytes);
  }
  // Data as crypto-js takes it: a string is UTF-8.
  function data(value) {
    if (value instanceof WordArray) return value;
    if (value && value.words !== undefined && value.sigBytes !== undefined) return new WordArray(value.words, value.sigBytes);
    return Utf8.parse(value === undefined || value === null ? "" : String(value));
  }

  var Hex = {
    stringify: function (wa) {
      var bytes = bytesOf(wa);
      var out = "";
      for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
      return out;
    },
    parse: function (text) {
      text = String(text);
      var bytes = new Uint8Array(text.length >>> 1);
      for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.substr(i * 2, 2), 16);
      return fromBytes(bytes);
    },
  };
  var Latin1 = {
    stringify: function (wa) {
      var bytes = bytesOf(wa);
      var out = "";
      for (var i = 0; i < bytes.length; i += 4096) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
      return out;
    },
    parse: function (text) {
      text = String(text);
      var bytes = new Uint8Array(text.length);
      for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
      return fromBytes(bytes);
    },
  };
  var Utf8 = {
    stringify: function (wa) {
      try {
        return host.decode(buf(wa), "utf-8", true);
      } catch (e) {
        throw new Error("Malformed UTF-8 data");
      }
    },
    parse: function (text) {
      return fromBuf(host.encodeUTF8(String(text)));
    },
  };
  function base64(alphabet) {
    return {
      stringify: function (wa) {
        var out = host.btoa(Latin1.stringify(wa));
        return alphabet === "url" ? out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : out;
      },
      parse: function (text) {
        text = String(text);
        if (alphabet === "url") text = text.replace(/-/g, "+").replace(/_/g, "/");
        // crypto-js stops at the padding and skips what isn't base64.
        text = text.split("=")[0].replace(/[^A-Za-z0-9+/]/g, "");
        if (text.length % 4 === 1) text = text.slice(0, -1);
        return Latin1.parse(host.atob(text));
      },
    };
  }
  function utf16(little) {
    return {
      stringify: function (wa) {
        var bytes = bytesOf(wa);
        var out = "";
        for (var i = 0; i + 1 < bytes.length; i += 2) {
          out += String.fromCharCode(little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
        }
        return out;
      },
      parse: function (text) {
        text = String(text);
        var bytes = new Uint8Array(text.length * 2);
        for (var i = 0; i < text.length; i++) {
          var c = text.charCodeAt(i);
          bytes[i * 2] = little ? c & 0xff : c >>> 8;
          bytes[i * 2 + 1] = little ? c >>> 8 : c & 0xff;
        }
        return fromBytes(bytes);
      },
    };
  }

  var C = {};
  C.lib = { WordArray: WordArray };
  C.enc = {
    Hex: Hex,
    Latin1: Latin1,
    Utf8: Utf8,
    Base64: base64("std"),
    Base64url: base64("url"),
    Utf16: utf16(false),
    Utf16BE: utf16(false),
    Utf16LE: utf16(true),
  };
  var Base64 = C.enc.Base64;

  // Hashes, HMAC and their incremental forms (C.algo.SHA256.create()).
  C.algo = {};
  function hashName(hasher, fallback) {
    if (!hasher) return fallback;
    if (typeof hasher === "string") return hasher;
    return hasher._name || fallback;
  }
  ["MD5", "SHA1", "SHA224", "SHA256", "SHA384", "SHA512", "SHA3"].forEach(function (name) {
    var hash = function (message) {
      return fromBuf(host.hash(name, buf(data(message))));
    };
    hash._name = name;
    C[name] = hash;
    C["Hmac" + name] = function (message, key) {
      return fromBuf(host.hmac(name, buf(data(key)), buf(data(message))));
    };
    C.algo[name] = {
      _name: name,
      create: function () {
        var parts = new WordArray();
        return {
          update: function (message) {
            parts.concat(data(message));
            return this;
          },
          finalize: function (message) {
            if (message !== undefined) this.update(message);
            return hash(parts);
          },
          reset: function () {
            parts = new WordArray();
          },
        };
      },
    };
  });
  C.algo.HMAC = {
    create: function (hasher, key) {
      var name = hashName(hasher, "SHA256");
      var parts = new WordArray();
      return {
        update: function (message) {
          parts.concat(data(message));
          return this;
        },
        finalize: function (message) {
          if (message !== undefined) this.update(message);
          return fromBuf(host.hmac(name, buf(data(key)), buf(parts)));
        },
        reset: function () {
          parts = new WordArray();
        },
      };
    },
  };

  // Key derivation. crypto-js 4.2's defaults: PBKDF2 is SHA256 with
  // 250,000 iterations, EvpKDF MD5 once; sizes are in 32-bit words.
  C.PBKDF2 = function (password, salt, cfg) {
    cfg = cfg || {};
    return fromBuf(
      host.pbkdf2(hashName(cfg.hasher, "SHA256"), buf(data(password)), buf(data(salt)), cfg.iterations || 250000, (cfg.keySize || 4) * 4),
    );
  };
  C.EvpKDF = function (password, salt, cfg) {
    cfg = cfg || {};
    return fromBuf(host.evpKDF(hashName(cfg.hasher, "MD5"), buf(data(password)), buf(data(salt)), cfg.iterations || 1, (cfg.keySize || 4) * 4));
  };
  C.algo.PBKDF2 = {
    create: function (cfg) {
      return {
        compute: function (password, salt) {
          return C.PBKDF2(password, salt, cfg);
        },
      };
    },
  };
  C.algo.EvpKDF = {
    create: function (cfg) {
      return {
        compute: function (password, salt) {
          return C.EvpKDF(password, salt, cfg);
        },
      };
    },
  };

  C.mode = {};
  ["CBC", "ECB", "CTR", "CFB", "OFB"].forEach(function (name) {
    C.mode[name] = { _name: name };
  });
  C.pad = {};
  ["Pkcs7", "AnsiX923", "Iso10126", "Iso97971", "ZeroPadding", "NoPadding"].forEach(function (name) {
    C.pad[name] = { _name: name };
  });

  // CipherParams and the formats that write and read them.
  function CipherParams(cfg) {
    var self = this;
    Object.keys(cfg || {}).forEach(function (k) {
      self[k] = cfg[k];
    });
  }
  CipherParams.prototype.toString = function (formatter) {
    return (formatter || this.formatter || OpenSSL).stringify(this);
  };
  C.lib.CipherParams = {
    create: function (cfg) {
      return new CipherParams(cfg);
    },
  };
  var salted = [0x53, 0x61, 0x6c, 0x74, 0x65, 0x64, 0x5f, 0x5f]; // "Salted__"
  var OpenSSL = {
    stringify: function (params) {
      var ct = data(params.ciphertext);
      if (!params.salt) return ct.toString(Base64);
      return fromBytes(new Uint8Array(salted)).concat(data(params.salt)).concat(ct).toString(Base64);
    },
    parse: function (text) {
      var bytes = bytesOf(Base64.parse(text));
      var isSalted =
        bytes.length >= 16 &&
        salted.every(function (b, i) {
          return bytes[i] === b;
        });
      if (!isSalted) return new CipherParams({ ciphertext: fromBytes(bytes) });
      return new CipherParams({ ciphertext: fromBytes(bytes.subarray(16)), salt: fromBytes(bytes.subarray(8, 16)) });
    },
  };
  C.format = {
    OpenSSL: OpenSSL,
    Hex: {
      stringify: function (params) {
        return data(params.ciphertext).toString(Hex);
      },
      parse: function (text) {
        return new CipherParams({ ciphertext: Hex.parse(text) });
      },
    },
  };
  C.kdf = {
    OpenSSL: {
      execute: function (password, keySize, ivSize, salt, hasher) {
        salt = salt ? data(salt) : WordArray.random(8);
        var derived = fromBuf(host.evpKDF(hashName(hasher, "MD5"), buf(data(password)), buf(salt), 1, (keySize + ivSize) * 4));
        return new CipherParams({ key: words(derived, 0, keySize), iv: words(derived, keySize, ivSize), salt: salt });
      },
    },
  };

  // AES, DES and TripleDES: a WordArray key with cfg.iv, or a passphrase
  // (a string), from which the key and IV come with the salt, as OpenSSL's
  // `enc` does.
  function cipher(name, keySize, ivSize) {
    function setup(key, cfg, salt) {
      if (typeof key === "string") {
        var derived = C.kdf.OpenSSL.execute(key, keySize, ivSize, salt, cfg.hasher);
        return { key: derived.key, iv: derived.iv, salt: derived.salt };
      }
      return { key: data(key), iv: cfg.iv === undefined ? undefined : data(cfg.iv), salt: undefined };
    }
    function run(encrypt, params, input, cfg) {
      var mode = (cfg.mode || C.mode.CBC)._name;
      var padding = (cfg.padding || C.pad.Pkcs7)._name;
      return fromBuf(host.cipher(encrypt, name, mode, padding, buf(params.key), params.iv ? buf(params.iv) : new ArrayBuffer(0), buf(input)));
    }
    var algo = {
      _name: name,
      keySize: keySize,
      ivSize: ivSize,
      encrypt: function (message, key, cfg) {
        cfg = cfg || {};
        var params = setup(key, cfg, cfg.salt);
        var ct = run(true, params, data(message), cfg);
        return new CipherParams({
          ciphertext: ct,
          key: params.key,
          iv: params.iv,
          salt: params.salt,
          algorithm: algo,
          mode: cfg.mode || C.mode.CBC,
          padding: cfg.padding || C.pad.Pkcs7,
          blockSize: name === "AES" ? 4 : 2,
          formatter: cfg.format || OpenSSL,
        });
      },
      decrypt: function (ciphertext, key, cfg) {
        cfg = cfg || {};
        var params;
        if (typeof ciphertext === "string") params = (cfg.format || OpenSSL).parse(ciphertext);
        else if (ciphertext instanceof WordArray) params = new CipherParams({ ciphertext: ciphertext });
        else params = ciphertext || {};
        var keys = setup(key, cfg, params.salt);
        return run(false, keys, data(params.ciphertext), cfg);
      },
    };
    return algo;
  }
  C.AES = cipher("AES", 8, 4);
  C.DES = cipher("DES", 2, 2);
  C.TripleDES = cipher("TripleDES", 6, 2);
  C.algo.AES = C.AES;
  C.algo.DES = C.DES;
  C.algo.TripleDES = C.TripleDES;

  C.default = C;
  return C;
});
